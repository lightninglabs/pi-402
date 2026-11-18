//! The `pi402` provider.
//!
//! The plugin sends the unpaid request itself: on a non-2xx response rpi's
//! built-in OpenAI-compatible provider keeps only the body text, so the
//! `WWW-Authenticate` challenge would never reach this code. Once it holds a
//! credential, the plugin hands the request to that built-in provider with
//! the credential in the `Authorization` header and retries disabled, which
//! reuses rpi's streaming translation for text, reasoning, and tool calls.
//!
//! A 402 from the delegated call arrives as an error event before any
//! content, without its headers. It may come from the seller, for a spent or
//! expired credential, or from the model behind it. The plugin repeats a
//! minimal request with the same credential: only a fresh L402 challenge in
//! answer shows the credential is spent, and then that challenge is paid.

use crate::challenge::{l402_from_headers, l402_from_json, L402Challenge};
use crate::payer::{PayError, Purchase};
use crate::plugin::Plugin;
use crate::store::Token;
use crate::util;
use rpi_ai::event_stream::create_assistant_message_event_stream_with_cancellation;
use rpi_ai::model::{MaxTokensField, OpenaiCompletionsCompat};
use rpi_ai::providers::openai_completions::OpenAiCompletionsProvider;
use rpi_ai::{
    Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream,
    AssistantMessageEventStreamProducer, Context, ErrorReason, Model, Provider,
    SimpleStreamOptions, StopReason, StreamingProtocolCompat,
};
use rpi_plugin_sdk::provider::ProviderContext;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub const PROVIDER_ID: &str = "pi402";

/// The API style the provider registers; its models must use the same API.
pub const API_STYLE: &str = "openai-completions";

/// Bound on the unpaid request that fetches a challenge.
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// Attempts per prompt: a spent cached credential, then one purchase.
const MAX_ROUNDS: usize = 3;

/// The model catalog. The id is the model name the seller receives, so the
/// credential cache key matches the TS extension's for the same model.
pub fn models(endpoint: &str) -> Vec<Model> {
    let mut model = Model::new(
        "deepseek-ai/DeepSeek-V4-Flash-0731",
        "DeepSeek V4 Flash (L402)",
        Api::OpenaiCompletions,
        PROVIDER_ID,
        endpoint,
    );
    model.reasoning = true;
    model.context_window = 1_000_000;
    model.max_tokens = 32_768;
    // The seller meters in sats; there is no per-token price here.
    model.cost_configured = true;
    // Send the request shape the TS extension sends: a system role, a plain
    // max_tokens, usage in the stream, and no reasoning parameters.
    model.compat = Some(StreamingProtocolCompat::OpenaiCompletions(
        OpenaiCompletionsCompat {
            supports_store: Some(false),
            supports_developer_role: Some(false),
            supports_reasoning_effort: Some(false),
            supports_usage_in_streaming: Some(true),
            max_tokens_field: Some(MaxTokensField::MaxTokens),
            ..Default::default()
        },
    ));
    vec![model]
}

/// The URL rpi's built-in provider posts to for `base_url`, by its rule.
pub fn chat_completions_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let versioned = base.rsplit('/').next().is_some_and(|segment| {
        segment.strip_prefix('v').is_some_and(|digits| {
            let count = digits.chars().take_while(char::is_ascii_digit).count();
            count > 0
                && digits
                    .chars()
                    .skip(count)
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
        })
    });
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else if versioned {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    }
}

/// The credential cache key, `<origin>|<path>|<model>|POST`, as the TS
/// extension computes it, so both use each other's credentials.
pub fn cache_key(url: &str, model: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(parsed) => format!(
            "{}|{}|{model}|POST",
            parsed.origin().ascii_serialization(),
            parsed.path()
        ),
        Err(_) => format!("{url}||{model}|POST"),
    }
}

/// The plugin's provider factory, called by the SDK bridge per request.
pub fn create(
    context: &ProviderContext,
    model: &Model,
    _options: &SimpleStreamOptions,
) -> Result<Arc<dyn Provider>, String> {
    let plugin = Plugin::global()?;
    let client = context.client(&model.base_url)?;
    Ok(Arc::new(Pi402Provider::new(plugin, client, model.clone())))
}

pub struct Pi402Provider {
    plugin: Arc<Plugin>,
    client: reqwest::Client,
    models: Vec<Model>,
}

impl Pi402Provider {
    pub fn new(plugin: Arc<Plugin>, client: reqwest::Client, model: Model) -> Self {
        Self {
            plugin,
            client,
            models: vec![model],
        }
    }
}

#[async_trait::async_trait]
impl Provider for Pi402Provider {
    fn id(&self) -> &str {
        PROVIDER_ID
    }

    fn models(&self) -> &[Model] {
        &self.models
    }

    async fn stream_simple(
        &self,
        model: &Model,
        ctx: &Context,
        opts: &SimpleStreamOptions,
    ) -> AssistantMessageEventStream {
        let (producer, stream) =
            create_assistant_message_event_stream_with_cancellation(&opts.signal);
        let request = PaidRequest {
            plugin: self.plugin.clone(),
            client: self.client.clone(),
            model: model.clone(),
            ctx: ctx.clone(),
            opts: opts.clone(),
        };
        tokio::spawn(request.run(producer));
        stream
    }
}

/// How a request stopped early.
enum Stop {
    Aborted,
    Failed(String),
}

/// What the seller answered to a probe.
enum Probe {
    /// It served the request: the route is free, or the credential is good.
    Accepted,
    /// It asked for payment with an L402 challenge.
    Challenge(L402Challenge),
    /// Anything else, such as a 402 without an L402 challenge.
    Other { status: u16, text: String },
}

enum Delegation {
    /// The delegated stream was forwarded to its end.
    Finished,
    /// The built-in provider reported HTTP 402 before any content. The event
    /// is kept to forward if the credential turns out to be good.
    PaymentRequired(Box<AssistantMessageEvent>),
}

/// Whether an event is the built-in provider's report of an HTTP 402.
fn payment_required(event: &AssistantMessageEvent) -> bool {
    matches!(
        event,
        AssistantMessageEvent::Error { error, .. }
            if matches!(error.stop_reason, StopReason::Error)
                && error
                    .error_message
                    .as_deref()
                    .is_some_and(|message| message.starts_with("http error 402"))
    )
}

async fn finish(
    producer: &mut AssistantMessageEventStreamProducer,
    model: &Model,
    reason: ErrorReason,
    stop: StopReason,
    message: &str,
) {
    let error = AssistantMessage::terminal(
        model.api.clone(),
        model.provider.clone(),
        model.id.clone(),
        stop,
        message,
        util::now_ms(),
    );
    producer
        .push(AssistantMessageEvent::Error { reason, error })
        .await;
}

async fn fail(producer: &mut AssistantMessageEventStreamProducer, model: &Model, message: &str) {
    finish(
        producer,
        model,
        ErrorReason::Error,
        StopReason::Error,
        message,
    )
    .await;
}

async fn abort(producer: &mut AssistantMessageEventStreamProducer, model: &Model) {
    finish(
        producer,
        model,
        ErrorReason::Aborted,
        StopReason::Aborted,
        "Request aborted",
    )
    .await;
}

/// One prompt to the seller.
struct PaidRequest {
    plugin: Arc<Plugin>,
    client: reqwest::Client,
    model: Model,
    ctx: Context,
    opts: SimpleStreamOptions,
}

impl PaidRequest {
    async fn run(self, mut producer: AssistantMessageEventStreamProducer) {
        let cancel = producer.cancellation_token();
        let url = chat_completions_url(&self.model.base_url);
        let key = cache_key(&url, &self.model.id);

        // A credential bought during this prompt is tried once and never paid
        // for again here, even if the seller refuses it.
        let mut paid = false;
        // A challenge already in hand from checking a refused credential.
        let mut pending: Option<L402Challenge> = None;
        // Whether the prompt was already sent again after the check probe
        // was served.
        let mut retried = false;
        for _ in 0..MAX_ROUNDS {
            let token = match self.plugin.tokens.get(&key) {
                Some(token) => Some(token),
                None => {
                    let challenge = match pending.take() {
                        Some(challenge) => Some(challenge),
                        None => match self.probe(&url, None, &cancel).await {
                            Ok(Probe::Accepted) => None,
                            Ok(Probe::Challenge(challenge)) => Some(challenge),
                            Ok(Probe::Other { status: 402, .. }) => {
                                let message =
                                    "rpi-402: the seller asked for payment without an L402 challenge";
                                return fail(&mut producer, &self.model, message).await;
                            }
                            Ok(Probe::Other { status, text }) => {
                                let message = format!("http error {status}: {text}");
                                return fail(&mut producer, &self.model, &message).await;
                            }
                            Err(stop) => return self.stop(&mut producer, stop).await,
                        },
                    };
                    match challenge {
                        // The seller serves this route without payment.
                        None => None,
                        Some(challenge) => match self.pay(&url, &key, challenge, &cancel).await {
                            Ok(token) => {
                                paid = true;
                                Some(token)
                            }
                            Err(stop) => return self.stop(&mut producer, stop).await,
                        },
                    }
                }
            };

            let refused = match self.delegate(token.as_ref(), &mut producer).await {
                Delegation::Finished => return,
                Delegation::PaymentRequired(event) => event,
            };
            // A 402 alone does not show the credential is spent: the model
            // behind the seller can answer 402 too. Only a fresh L402
            // challenge in answer to this credential does. A credential
            // bought for this prompt, or a prompt already sent again after a
            // served probe, gets no further probe: each one costs a
            // completion.
            let Some(token) = token.filter(|_| !paid && !retried) else {
                producer.push(*refused).await;
                return;
            };
            match self.probe(&url, Some(&token), &cancel).await {
                Ok(Probe::Challenge(challenge)) => {
                    if let Err(err) = self.plugin.tokens.remove_if(&key, &token) {
                        self.plugin
                            .log
                            .warn(&format!("cannot drop a spent credential for {key}: {err}"));
                    }
                    pending = Some(challenge);
                }
                // The seller and the model served the probe, so the 402 was
                // passing; the probe's one-token completion is already paid
                // for, so send the prompt once more rather than report it.
                Ok(Probe::Accepted) => retried = true,
                Ok(_) => {
                    producer.push(*refused).await;
                    return;
                }
                Err(stop) => return self.stop(&mut producer, stop).await,
            }
        }
        fail(
            &mut producer,
            &self.model,
            "rpi-402: the seller kept asking for payment",
        )
        .await;
    }

    async fn stop(&self, producer: &mut AssistantMessageEventStreamProducer, stop: Stop) {
        match stop {
            Stop::Aborted => abort(producer, &self.model).await,
            Stop::Failed(message) => fail(producer, &self.model, &message).await,
        }
    }

    /// Buy a credential for `challenge`. The payment runs in its own task: a
    /// cancel stops this request, but a payment already sent finishes in the
    /// background and is recorded.
    async fn pay(
        &self,
        url: &str,
        key: &str,
        challenge: L402Challenge,
        cancel: &CancellationToken,
    ) -> Result<Token, Stop> {
        let purchase = Purchase {
            cache_key: key.to_string(),
            url: url.to_string(),
            model: self.model.id.clone(),
            challenge,
        };
        let plugin = self.plugin.clone();
        let payment_cancel = cancel.clone();
        let mut payment = tokio::spawn(async move { plugin.buy(purchase, payment_cancel).await });
        tokio::select! {
            biased;
            joined = &mut payment => match joined {
                Ok(Ok(token)) => Ok(token),
                Ok(Err(PayError::Aborted)) => Err(Stop::Aborted),
                Ok(Err(err)) => Err(Stop::Failed(err.to_string())),
                Err(err) => Err(Stop::Failed(format!("rpi-402: the payment task failed: {err}"))),
            },
            _ = cancel.cancelled() => Err(Stop::Aborted),
        }
    }

    /// Send a minimal request to the seller: without a credential to get its
    /// challenge, or with one to learn whether the seller still accepts it.
    /// A seller that charges answers a request without a usable credential
    /// with 402 and does not run the model; with a good credential it runs a
    /// one-token completion.
    async fn probe(
        &self,
        url: &str,
        credential: Option<&Token>,
        cancel: &CancellationToken,
    ) -> Result<Probe, Stop> {
        let body = json!({
            "model": self.model.id,
            "messages": [{"role": "user", "content": "402"}],
            "max_tokens": 1,
            "stream": false,
        });
        let mut request = self.client.post(url).timeout(PROBE_TIMEOUT).json(&body);
        let headers = self
            .model
            .headers
            .iter()
            .flatten()
            .chain(self.opts.headers.iter().flatten());
        for (name, value) in headers {
            if !name.eq_ignore_ascii_case("authorization") {
                request = request.header(name.as_str(), value.as_str());
            }
        }
        if let Some(token) = credential {
            request = request.header(reqwest::header::AUTHORIZATION, token.authorization());
        }

        let response = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Stop::Aborted),
            response = request.send() => response.map_err(|err| {
                Stop::Failed(format!("rpi-402: cannot reach the seller at {url}: {err}"))
            })?,
        };

        let status = response.status();
        if status.is_success() {
            return Ok(Probe::Accepted);
        }
        let header_values: Vec<String> = response
            .headers()
            .get_all(reqwest::header::WWW_AUTHENTICATE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .map(str::to_string)
            .collect();
        let json_body = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("application/json"));
        let text = response.text().await.unwrap_or_default();
        if status.as_u16() == 402 {
            let from_body = if json_body {
                serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|body| l402_from_json(&body))
            } else {
                None
            };
            let challenge =
                from_body.or_else(|| l402_from_headers(header_values.iter().map(String::as_str)));
            if let Some(challenge) = challenge {
                return Ok(Probe::Challenge(challenge));
            }
        }
        Ok(Probe::Other {
            status: status.as_u16(),
            text,
        })
    }

    /// Run the request through rpi's built-in provider with `token` as the
    /// credential, forwarding its events.
    async fn delegate(
        &self,
        token: Option<&Token>,
        producer: &mut AssistantMessageEventStreamProducer,
    ) -> Delegation {
        let inner = OpenAiCompletionsProvider::with_models_without_auth(
            self.model.provider.clone(),
            self.client.clone(),
            vec![self.model.clone()],
        );
        let mut opts = self.opts.clone();
        // An API key would replace the Authorization header with a bearer
        // token, and a retry inside the built-in provider must not re-enter
        // the seller with a credential this code has not checked.
        opts.api_key = None;
        opts.max_retries = Some(0);
        let mut headers = opts.headers.take().unwrap_or_default();
        let authorization = token.map(Token::authorization);
        rpi_ai::provider::set_http_header(&mut headers, "Authorization", authorization.as_deref());
        opts.headers = Some(headers);

        let mut events = inner.stream_simple(&self.model, &self.ctx, &opts).await;
        let mut first = true;
        while let Some(event) = events.next().await {
            if first && payment_required(&event) {
                return Delegation::PaymentRequired(Box::new(event));
            }
            first = false;
            let terminal = event.is_terminal();
            let delivered = producer.push(event).await;
            if terminal || !delivered {
                return Delegation::Finished;
            }
        }
        fail(
            producer,
            &self.model,
            "rpi-402: the model stream ended without a final event",
        )
        .await;
        Delegation::Finished
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_follow_the_built_in_provider() {
        assert_eq!(
            chat_completions_url("http://s/v1/chat/completions"),
            "http://s/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("http://s/v1/"),
            "http://s/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("http://s/api/v3"),
            "http://s/api/v3/chat/completions"
        );
        assert_eq!(
            chat_completions_url("http://s"),
            "http://s/v1/chat/completions"
        );
    }

    #[test]
    fn cache_keys_match_the_ts_extension() {
        assert_eq!(
            cache_key(
                "http://localhost:8402/chat/completions",
                "deepseek-ai/DeepSeek-V4-Flash-0731"
            ),
            "http://localhost:8402|/chat/completions|deepseek-ai/DeepSeek-V4-Flash-0731|POST"
        );
        assert_eq!(
            cache_key("https://seller.example:443/v1/chat/completions", "m"),
            "https://seller.example|/v1/chat/completions|m|POST"
        );
    }

    #[test]
    fn the_catalog_declares_the_registered_api() {
        let models = models("http://s/chat/completions");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].provider, PROVIDER_ID);
        assert!(matches!(models[0].api, Api::OpenaiCompletions));
        let manifest = serde_json::to_value(&models[0]).unwrap();
        assert_eq!(manifest["api"], API_STYLE);
    }
}
