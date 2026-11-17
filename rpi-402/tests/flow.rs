//! End-to-end checks of the paid request path against a mock Aperture seller
//! and a mock `waved` gateway. They mirror the plan's regtest acceptance
//! checks without a regtest stack.

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use base64::Engine;
use rpi_402::config::Config;
use rpi_402::plugin::Plugin;
use rpi_402::provider::{cache_key, models, Pi402Provider};
use rpi_ai::{
    AssistantMessage, AssistantMessageEvent, Content, Context, Message, Model, Provider,
    SimpleStreamOptions, StopReason, UserContent, UserMessage,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

const PASSWORD: &str = "pi402-dev-password";

#[derive(Clone, Copy, PartialEq)]
enum Settle {
    Now,
    After(Duration),
    Never,
    Fail,
}

/// A prepared send: what it pays, its quoted fee, and the fee cap the
/// wallet enforces at dispatch.
#[derive(Clone)]
struct MockQuote {
    hash: String,
    amount: u64,
    fee: u64,
    max_fee: Option<u64>,
}

struct Bundle {
    payment_hash: String,
    credit: u32,
}

/// Everything the two mock services share.
struct World {
    // Seller.
    price_sat: u64,
    bundle_credit: u32,
    bundles: HashMap<String, Bundle>,
    challenges: usize,
    served: usize,
    next: u64,
    // Gateway.
    exists: bool,
    unlocked: bool,
    password: String,
    fee_sat: u64,
    confirmed_sat: u64,
    settle: Settle,
    /// The quote's `total_outflow_known`; false mimics a wallet that could
    /// not get a server quote.
    total_known: bool,
    /// How long the subscribe call waits before answering, as a gateway
    /// does while the daemon holds back stream headers.
    subscribe_delay: Duration,
    /// Start the payment but answer `/send` with an error, and publish the
    /// activity row only after `row_delay`.
    lose_send_response: bool,
    row_delay: Duration,
    /// Answer a good credential with a 402 that carries no L402 challenge,
    /// as a model behind the seller might.
    upstream_402: bool,
    preimages: HashMap<String, String>,
    quotes: HashMap<String, MockQuote>,
    /// Bodies of every prepare-send call, in order.
    prepare_bodies: Vec<Value>,
    /// How much the fee rises between the quote and the send, up to the
    /// quote's fee cap.
    fee_change_sat: i64,
    /// Quote a zero total, as when credit covers the whole invoice.
    credit_funded: bool,
    /// Answer the next good credential with an upstream 402, once.
    upstream_402_once: bool,
    /// Answer every full prompt (a streaming request) with an upstream 402,
    /// while serving the plugin's minimal probe.
    prompt_402: bool,
    /// Hold back the subscribe response until the wallet has an entry, as
    /// waved does for a wallet with no history.
    idle_subscribe: bool,
    /// Added to the total of every quote after the first, as a quote that
    /// draws less on credit.
    quote_bump_sat: u64,
    /// Whether activity inspection answers; when it does, it reports the
    /// fee each payment's swap charged.
    inspect_available: bool,
    swap_fees: HashMap<String, u64>,
    entries: Vec<Value>,
    calls: Vec<String>,
}

impl Default for World {
    fn default() -> Self {
        Self {
            price_sat: 100,
            bundle_credit: 10,
            bundles: HashMap::new(),
            challenges: 0,
            served: 0,
            next: 0,
            exists: true,
            unlocked: false,
            password: PASSWORD.to_string(),
            fee_sat: 3,
            confirmed_sat: 100_000,
            settle: Settle::Now,
            total_known: true,
            subscribe_delay: Duration::ZERO,
            lose_send_response: false,
            row_delay: Duration::ZERO,
            upstream_402: false,
            preimages: HashMap::new(),
            quotes: HashMap::new(),
            prepare_bodies: Vec::new(),
            fee_change_sat: 0,
            credit_funded: false,
            upstream_402_once: false,
            prompt_402: false,
            idle_subscribe: false,
            quote_bump_sat: 0,
            inspect_available: true,
            swap_fees: HashMap::new(),
            entries: Vec::new(),
            calls: Vec::new(),
        }
    }
}

struct Shared {
    world: Mutex<World>,
    frames: broadcast::Sender<String>,
}

type S = State<Arc<Shared>>;

fn frame(entry: &Value) -> String {
    format!("{}\n", json!({"result": {"cursor": "1", "entry": entry}}))
}

fn not_ready() -> Response {
    (
        StatusCode::PRECONDITION_FAILED,
        Json(json!({"code": 9, "message": "wallet not ready", "details": [{"reason": "WALLET_NOT_READY"}]})),
    )
        .into_response()
}

// ---- Seller ----

async fn completions(State(shared): S, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let mut world = shared.world.lock().unwrap();
    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("L402 "))
        .and_then(|value| value.split_once(':'))
        .map(|(mac, pre)| (mac.to_string(), pre.to_string()));
    if let Some((macaroon, preimage)) = presented {
        if let Some(bundle) = world.bundles.get_mut(&macaroon) {
            let hash = hex::encode(Sha256::digest(hex::decode(&preimage).unwrap_or_default()));
            let good = hash == bundle.payment_hash && bundle.credit > 0;
            let once = good && world.upstream_402_once;
            if once {
                world.upstream_402_once = false;
            }
            let prompt = body["stream"].as_bool() == Some(true);
            if good && (world.upstream_402 || once || (prompt && world.prompt_402)) {
                return (
                    StatusCode::PAYMENT_REQUIRED,
                    Json(json!({"error": "upstream account out of credit"})),
                )
                    .into_response();
            }
            let bundle = world.bundles.get_mut(&macaroon).unwrap();
            if good {
                bundle.credit -= 1;
                world.served += 1;
                let chunks = [
                    json!({"id": "c", "object": "chat.completion.chunk", "created": 0, "model": "m",
                           "choices": [{"index": 0, "delta": {"role": "assistant", "content": "hello"}, "finish_reason": null}]}),
                    json!({"id": "c", "object": "chat.completion.chunk", "created": 0, "model": "m",
                           "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}),
                    json!({"id": "c", "object": "chat.completion.chunk", "created": 0, "model": "m", "choices": [],
                           "usage": {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6}}),
                ];
                let mut body: String = chunks
                    .iter()
                    .map(|chunk| format!("data: {chunk}\n\n"))
                    .collect();
                body.push_str("data: [DONE]\n\n");
                return ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response();
            }
        }
    }

    // No usable credential: mint a bundle and challenge for it, merged with
    // an MPP offer the way aperture --enablempp does.
    world.next += 1;
    world.challenges += 1;
    let preimage = hex::encode(Sha256::digest(format!("preimage-{}", world.next)));
    let hash = hex::encode(Sha256::digest(hex::decode(&preimage).unwrap()));
    let macaroon =
        base64::engine::general_purpose::STANDARD.encode(format!("macaroon-{}", world.next));
    let invoice = format!("lnmock{}x{hash}", world.price_sat);
    world.preimages.insert(hash.clone(), preimage);
    let credit = world.bundle_credit;
    world.bundles.insert(
        macaroon.clone(),
        Bundle {
            payment_hash: hash,
            credit,
        },
    );
    let challenge = format!(
        r#"Payment id="x", realm="seller", method="lightning", intent="charge", request="e30", L402 macaroon="{macaroon}", invoice="{invoice}""#
    );
    (
        StatusCode::PAYMENT_REQUIRED,
        [(header::WWW_AUTHENTICATE, challenge)],
        "payment required",
    )
        .into_response()
}

// ---- Gateway ----

fn record(world: &mut World, path: &str) {
    world.calls.push(path.to_string());
}

async fn status(State(shared): S) -> Response {
    let mut world = shared.world.lock().unwrap();
    record(&mut world, "/v1/wallet/status");
    if !world.exists {
        return not_ready();
    }
    Json(json!({"ready": true, "unlocked": world.unlocked, "network": "regtest"})).into_response()
}

fn decode_password(body: &Value) -> String {
    let encoded = body["wallet_password"].as_str().unwrap_or("");
    String::from_utf8(
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap_or_default(),
    )
    .unwrap_or_default()
}

async fn unlock(State(shared): S, Json(body): Json<Value>) -> Response {
    let mut world = shared.world.lock().unwrap();
    record(&mut world, "/v1/wallet/unlock");
    if !world.exists {
        return not_ready();
    }
    if decode_password(&body) != world.password {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"code": 3, "message": "invalid passphrase"})),
        )
            .into_response();
    }
    world.unlocked = true;
    Json(json!({})).into_response()
}

async fn create(State(shared): S, Json(body): Json<Value>) -> Response {
    let mut world = shared.world.lock().unwrap();
    record(&mut world, "/v1/wallet/create");
    world.exists = true;
    world.unlocked = true;
    world.password = decode_password(&body);
    Json(json!({"mnemonic": vec!["abandon"; 24]})).into_response()
}

async fn prepare_send(State(shared): S, Json(body): Json<Value>) -> Response {
    let mut world = shared.world.lock().unwrap();
    record(&mut world, "/v1/wallet/prepare-send");
    assert!(
        body["max_credit_sat"].as_u64().unwrap() > 0,
        "the credit cap must be set"
    );
    let invoice = body["invoice"].as_str().unwrap();
    let (amount, hash) = invoice
        .strip_prefix("lnmock")
        .unwrap()
        .split_once('x')
        .unwrap();
    let amount: u64 = amount.parse().unwrap();
    world.next += 1;
    let id = format!("si-{}", world.next);
    let fee = world.fee_sat;
    let max_fee = body["max_fee_sat"].as_u64();
    world.prepare_bodies.push(body.clone());
    world.quotes.insert(
        id.clone(),
        MockQuote {
            hash: hash.to_string(),
            amount,
            fee,
            max_fee,
        },
    );
    let bump = if world.prepare_bodies.len() > 1 {
        world.quote_bump_sat
    } else {
        0
    };
    let total = if world.credit_funded {
        0
    } else {
        amount + fee + bump
    };
    Json(json!({
        "send_intent_id": id,
        "amount_sat": amount.to_string(),
        "expected_fee_sat": fee.to_string(),
        "expected_total_outflow_sat": total.to_string(),
        "total_outflow_known": world.total_known,
        "payment_hash": hash,
        "expires_at_unix": (chrono::Utc::now().timestamp() + 600).to_string(),
    }))
    .into_response()
}

async fn balance(State(shared): S) -> Response {
    let mut world = shared.world.lock().unwrap();
    record(&mut world, "/v1/wallet/balance");
    Json(json!({"confirmed_sat": world.confirmed_sat.to_string(), "pending_in_sat": "0"}))
        .into_response()
}

fn complete(shared: &Shared, hash: &str, fail: bool) {
    let frame_text = {
        let mut world = shared.world.lock().unwrap();
        let preimage = world.preimages.get(hash).cloned().unwrap_or_default();
        let entry = world
            .entries
            .iter_mut()
            .find(|entry| entry["progress"]["payment_hash"] == hash)
            .expect("a send for this hash");
        if fail {
            entry["status"] = json!("ENTRY_STATUS_FAILED");
            entry["failure_reason"] = json!("no route");
        } else {
            entry["status"] = json!("ENTRY_STATUS_COMPLETE");
            entry["progress"]["preimage"] = json!(preimage);
        }
        frame(entry)
    };
    let _ = shared.frames.send(frame_text);
}

async fn send(State(shared): S, Json(body): Json<Value>) -> Response {
    let (hash, settle, entry, lose, row_delay) = {
        let mut world = shared.world.lock().unwrap();
        record(&mut world, "/v1/wallet/send");
        let id = body["send_intent_id"].as_str().unwrap();
        let quote = world.quotes[id].clone();
        let hash = quote.hash.clone();
        // The fee at dispatch can differ from the quote. Above a positive
        // cap, waved rejects the send before it starts the payment.
        let fee = (quote.fee as i64 + world.fee_change_sat).max(0) as u64;
        if let Some(max_fee) = quote.max_fee.filter(|max_fee| *max_fee > 0) {
            if fee > max_fee {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"code": 2, "message": format!(
                        "start pay: in-swap fee {fee} exceeds max fee {max_fee}")})),
                )
                    .into_response();
            }
        }
        world.swap_fees.insert(hash.clone(), fee);
        // A Lightning send's amount is the invoice plus the fee; a credit
        // send shows the face value and no fee, which the gateway, emitting
        // unpopulated fields, serializes as "0".
        let entry = if world.credit_funded {
            json!({"id": id, "kind": "ENTRY_KIND_SEND", "status": "ENTRY_STATUS_PENDING",
                   "amount_sat": format!("-{}", quote.amount), "fee_sat": "0",
                   "progress": {"payment_hash": hash}})
        } else {
            json!({"id": id, "kind": "ENTRY_KIND_SEND", "status": "ENTRY_STATUS_PENDING",
                   "amount_sat": format!("-{}", quote.amount + fee), "fee_sat": fee.to_string(),
                   "progress": {"payment_hash": hash}})
        };
        (
            hash,
            world.settle,
            entry,
            world.lose_send_response,
            world.row_delay,
        )
    };
    let settle_after = match settle {
        Settle::Now => Some((Duration::from_millis(20), false)),
        Settle::After(delay) => Some((delay, false)),
        Settle::Fail => Some((Duration::from_millis(20), true)),
        Settle::Never => None,
    };
    // The payment has started; its activity row appears after row_delay.
    let task_shared = shared.clone();
    let task_entry = entry.clone();
    tokio::spawn(async move {
        tokio::time::sleep(row_delay).await;
        task_shared
            .world
            .lock()
            .unwrap()
            .entries
            .push(task_entry.clone());
        let _ = task_shared.frames.send(frame(&task_entry));
        if let Some((delay, fail)) = settle_after {
            tokio::time::sleep(delay).await;
            complete(&task_shared, &hash, fail);
        }
    });
    if lose {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"code": 14, "message": "connection reset"})),
        )
            .into_response();
    }
    // Without a delay, answer once the row is visible, as waved does.
    tokio::time::sleep(row_delay + Duration::from_millis(5)).await;
    Json(json!({"entry": entry})).into_response()
}

async fn subscribe(State(shared): S) -> Response {
    let delay = {
        let mut world = shared.world.lock().unwrap();
        record(&mut world, "/v1/wallet/subscribe");
        world.subscribe_delay
    };
    tokio::time::sleep(delay).await;
    let live = shared.frames.subscribe();
    loop {
        let waiting = {
            let world = shared.world.lock().unwrap();
            world.idle_subscribe && world.entries.is_empty()
        };
        if !waiting {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let existing: Vec<String> = {
        let world = shared.world.lock().unwrap();
        world.entries.iter().map(frame).collect()
    };
    let stream = tokio_stream::iter(existing)
        .chain(BroadcastStream::new(live).filter_map(Result::ok))
        .map(|text| Ok::<_, Infallible>(Bytes::from(text)));
    (
        [(header::CONTENT_TYPE, "application/x-ndjson")],
        Body::from_stream(stream),
    )
        .into_response()
}

async fn list(State(shared): S) -> Response {
    let mut world = shared.world.lock().unwrap();
    record(&mut world, "/v1/wallet/list");
    Json(json!({"activity": {"entries": world.entries, "has_more": false}})).into_response()
}

async fn inspect(State(shared): S, Json(body): Json<Value>) -> Response {
    let mut world = shared.world.lock().unwrap();
    record(&mut world, "/v1/wallet/inspect/activity");
    if !world.inspect_available {
        return (
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({"code": 12, "message": "unknown service"})),
        )
            .into_response();
    }
    let id = body["id"].as_str().unwrap_or("");
    let swap = match world.swap_fees.get(id) {
        Some(fee) => json!({"payment_hash": id, "fee_sat": fee.to_string()}),
        None => Value::Null,
    };
    Json(json!({"swap": swap})).into_response()
}

// ---- Harness ----

struct Harness {
    shared: Arc<Shared>,
    endpoint: String,
    gateway: String,
    dir: tempfile::TempDir,
}

impl Harness {
    async fn start(configure: impl FnOnce(&mut World)) -> Self {
        let mut world = World::default();
        configure(&mut world);
        let (frames, _) = broadcast::channel(256);
        let shared = Arc::new(Shared {
            world: Mutex::new(world),
            frames,
        });
        let app = Router::new()
            .route("/v1/chat/completions", post(completions))
            .route("/v1/wallet/status", post(status))
            .route("/v1/wallet/unlock", post(unlock))
            .route("/v1/wallet/create", post(create))
            .route("/v1/wallet/prepare-send", post(prepare_send))
            .route("/v1/wallet/balance", post(balance))
            .route("/v1/wallet/send", post(send))
            .route("/v1/wallet/subscribe", post(subscribe))
            .route("/v1/wallet/list", post(list))
            .route("/v1/wallet/inspect/activity", post(inspect))
            .with_state(shared.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            shared,
            endpoint: format!("http://{address}/v1/chat/completions"),
            gateway: format!("http://{address}"),
            dir: tempfile::tempdir().unwrap(),
        }
    }

    fn config(&self) -> Config {
        Config {
            gateway: self.gateway.clone(),
            wallet_password: PASSWORD.to_string(),
            max_sat_per_request: 1_000.0,
            daily_cap_sat: 100_000.0,
            data_dir: self.dir.path().to_path_buf(),
            preimage_timeout: Duration::from_secs(10),
        }
    }

    fn plugin(&self) -> Arc<Plugin> {
        self.plugin_with(|_| {})
    }

    fn plugin_with(&self, tweak: impl FnOnce(&mut Config)) -> Arc<Plugin> {
        let mut config = self.config();
        tweak(&mut config);
        Arc::new(Plugin::new(config).unwrap())
    }

    fn model(&self) -> Model {
        models(&self.endpoint).remove(0)
    }

    fn calls(&self, path: &str) -> usize {
        self.shared
            .world
            .lock()
            .unwrap()
            .calls
            .iter()
            .filter(|call| *call == path)
            .count()
    }

    fn sends(&self) -> usize {
        self.calls("/v1/wallet/send")
    }

    fn world<R>(&self, f: impl FnOnce(&mut World) -> R) -> R {
        f(&mut self.shared.world.lock().unwrap())
    }

    fn receipts(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir.path().join("receipts.ndjson"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    /// The recorded intents, by payment hash.
    fn intents(&self) -> serde_json::Map<String, Value> {
        let Ok(entries) = std::fs::read_dir(self.dir.path().join("intents")) else {
            return serde_json::Map::new();
        };
        entries
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
            .map(|path| {
                let intent: Value =
                    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
                (intent["paymentHash"].as_str().unwrap().to_string(), intent)
            })
            .collect()
    }

    fn token_keys(&self) -> Vec<String> {
        std::fs::read_to_string(self.dir.path().join("tokens.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|state| {
                state["tokens"]
                    .as_object()
                    .map(|tokens| tokens.keys().cloned().collect())
            })
            .unwrap_or_default()
    }

    async fn prompt(&self, plugin: &Arc<Plugin>) -> AssistantMessage {
        self.prompt_with(plugin, &SimpleStreamOptions::default())
            .await
    }

    async fn prompt_with(
        &self,
        plugin: &Arc<Plugin>,
        opts: &SimpleStreamOptions,
    ) -> AssistantMessage {
        let provider = Pi402Provider::new(plugin.clone(), reqwest::Client::new(), self.model());
        let context = Context::new(vec![Message::User(UserMessage::new(
            UserContent::Text("hi".into()),
            0,
        ))]);
        let mut stream = provider.stream_simple(&self.model(), &context, opts).await;
        let run = async {
            while let Some(event) = stream.next().await {
                match event {
                    AssistantMessageEvent::Done { message, .. } => return message,
                    AssistantMessageEvent::Error { error, .. } => return error,
                    _ => {}
                }
            }
            panic!("the stream ended without a terminal event");
        };
        tokio::time::timeout(Duration::from_secs(30), run)
            .await
            .expect("the prompt timed out")
    }
}

fn text(message: &AssistantMessage) -> String {
    message
        .content
        .iter()
        .filter_map(|content| match content {
            Content::Text(text) => Some(text.text.as_str()),
            _ => None,
        })
        .collect()
}

fn assert_served(message: &AssistantMessage) {
    assert!(
        !matches!(message.stop_reason, StopReason::Error | StopReason::Aborted),
        "expected a response, got {:?}: {:?}",
        message.stop_reason,
        message.error_message
    );
    assert_eq!(text(message), "hello");
}

fn error_of(message: &AssistantMessage) -> String {
    assert!(
        matches!(message.stop_reason, StopReason::Error),
        "expected an error, got {:?}",
        message.stop_reason
    );
    message.error_message.clone().unwrap_or_default()
}

async fn eventually(what: &str, check: impl Fn() -> bool) {
    for _ in 0..200 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for {what}");
}

// ---- Checks ----

#[tokio::test(flavor = "multi_thread")]
async fn two_prompts_one_payment_across_a_restart() {
    let harness = Harness::start(|_| {}).await;
    let first = harness.plugin();
    assert_served(&harness.prompt(&first).await);

    // A new plugin instance over the same directory stands in for a restart.
    let second = harness.plugin();
    assert_served(&harness.prompt(&second).await);

    assert_eq!(harness.sends(), 1);
    assert_eq!(harness.world(|world| world.challenges), 1);
    assert_eq!(
        harness.calls("/v1/wallet/unlock"),
        1,
        "a locked wallet is unlocked"
    );
    assert_eq!(
        harness.calls("/v1/wallet/create"),
        0,
        "an existing wallet is never recreated"
    );

    let receipts = harness.receipts();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0]["amountSat"], 100);
    assert_eq!(receipts[0]["paidSat"], 103);
    assert_eq!(receipts[0]["model"], harness.model().id);
    assert_eq!(receipts[0]["url"], harness.endpoint);
    assert_eq!(
        harness.token_keys(),
        vec![cache_key(&harness.endpoint, &harness.model().id)]
    );
    assert!(harness.intents().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_spent_bundle_is_replaced_with_one_payment() {
    let harness = Harness::start(|world| world.bundle_credit = 1).await;
    let plugin = harness.plugin();
    assert_served(&harness.prompt(&plugin).await);
    assert_served(&harness.prompt(&plugin).await);
    assert_eq!(harness.sends(), 2);
    assert_eq!(harness.receipts().len(), 2);
    assert_eq!(harness.token_keys().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_credential_bought_by_pi_is_spent_without_paying() {
    let harness = Harness::start(|_| {}).await;
    // Buy in one instance, then point a fresh one at a tokens.json written
    // in the TS extension's exact format.
    let plugin = harness.plugin();
    assert_served(&harness.prompt(&plugin).await);
    let raw = std::fs::read_to_string(harness.dir.path().join("tokens.json")).unwrap();
    let state: Value = serde_json::from_str(&raw).unwrap();
    let key = cache_key(&harness.endpoint, &harness.model().id);
    let token = &state["tokens"][&key];
    let ts_file = format!(
        "{{\n\t\"version\": 1,\n\t\"tokens\": {{\n\t\t\"{key}\": {{\n\t\t\t\"macaroonB64\": \"{}\",\n\t\t\t\"preimageHex\": \"{}\",\n\t\t\t\"expiresAt\": \"\"\n\t\t}}\n\t}}\n}}",
        token["macaroonB64"].as_str().unwrap(),
        token["preimageHex"].as_str().unwrap()
    );
    std::fs::write(harness.dir.path().join("tokens.json"), ts_file).unwrap();
    assert_served(&harness.prompt(&harness.plugin()).await);
    assert_eq!(harness.sends(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_per_request_ceiling_counts_fees() {
    let harness = Harness::start(|world| {
        world.price_sat = 990;
        world.fee_sat = 20;
    })
    .await;
    let error = error_of(&harness.prompt(&harness.plugin()).await);
    assert!(
        error.contains("this payment, with fees, is 1,010 sat"),
        "{error}"
    );
    assert_eq!(harness.calls("/v1/wallet/prepare-send"), 1);
    assert_eq!(harness.sends(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_daily_cap_counts_fees_and_the_shared_ledger() {
    let harness = Harness::start(|world| {
        world.price_sat = 95;
        world.fee_sat = 10;
    })
    .await;
    // 900 sat already spent today, by Pi for all this process knows.
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    std::fs::write(
        harness.dir.path().join("receipts.ndjson"),
        format!(
            "{}\n",
            json!({"paymentHash": "pi", "amountSat": 880, "paidSat": 900, "timestamp": now})
        ),
    )
    .unwrap();
    // The invoice alone fits (900 + 95 <= 1,000); with the fee it does not.
    let plugin = harness.plugin_with(|config| config.daily_cap_sat = 1_000.0);
    let error = error_of(&harness.prompt(&plugin).await);
    assert!(error.contains("daily limit"), "{error}");
    assert_eq!(harness.sends(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_balance_must_cover_the_quote() {
    let harness = Harness::start(|world| world.confirmed_sat = 50).await;
    let error = error_of(&harness.prompt(&harness.plugin()).await);
    assert!(error.contains("available balance is 50 sat"), "{error}");
    assert_eq!(harness.sends(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancel_after_dispatch_lets_the_payment_finish() {
    // Settlement is held until the test releases it.
    let harness = Harness::start(|world| world.settle = Settle::Never).await;
    let plugin = harness.plugin();
    let opts = SimpleStreamOptions::default();
    let signal = opts.signal.clone();
    let shared = harness.shared.clone();
    tokio::spawn(async move {
        loop {
            if shared
                .world
                .lock()
                .unwrap()
                .calls
                .iter()
                .any(|call| call == "/v1/wallet/send")
            {
                signal.cancel();
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    });
    let message = harness.prompt_with(&plugin, &opts).await;
    assert!(
        matches!(message.stop_reason, StopReason::Aborted),
        "{:?}",
        message.stop_reason
    );
    let intents = harness.intents();
    let (hash, intent) = intents.iter().next().unwrap();
    let created = intent["createdAt"].clone();
    eventually("the send to reach the wallet's activity", || {
        harness.world(|world| !world.entries.is_empty())
    })
    .await;
    complete(&harness.shared, hash, false);

    eventually("the background payment to be recorded", || {
        harness.receipts().len() == 1
    })
    .await;
    assert_eq!(
        harness.receipts()[0]["timestamp"],
        created,
        "dated by the intent on live settlement"
    );
    eventually("the credential to be stored", || {
        harness.token_keys().len() == 1
    })
    .await;
    eventually("the intent to close", || harness.intents().is_empty()).await;
    assert_served(&harness.prompt(&plugin).await);
    assert_eq!(harness.sends(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancel_before_dispatch_sends_nothing() {
    let harness = Harness::start(|_| {}).await;
    let opts = SimpleStreamOptions::default();
    opts.signal.cancel();
    let message = harness.prompt_with(&harness.plugin(), &opts).await;
    assert!(
        matches!(message.stop_reason, StopReason::Aborted),
        "{:?}",
        message.stop_reason
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(harness.sends(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restart_recovers_a_payment_that_settled_later() {
    let harness = Harness::start(|world| world.settle = Settle::Never).await;
    let first = harness.plugin_with(|config| config.preimage_timeout = Duration::from_millis(300));
    let error = error_of(&harness.prompt(&first).await);
    assert!(error.contains("has not settled"), "{error}");
    let intents = harness.intents();
    assert_eq!(intents.len(), 1);
    let hash = intents.keys().next().unwrap().clone();
    assert_eq!(intents[&hash]["status"], "pending");
    let created = intents[&hash]["createdAt"].clone();

    // The swap completes while rpi is down.
    complete(&harness.shared, &hash, false);
    let second = harness.plugin();
    assert_served(&harness.prompt(&second).await);
    assert_eq!(
        harness.sends(),
        1,
        "the recorded payment is recovered, not repeated"
    );
    assert_eq!(harness.receipts().len(), 1);
    assert_eq!(
        harness.receipts()[0]["timestamp"],
        created,
        "dated by the intent on recovery"
    );
    assert!(harness.intents().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stuck_intent_blocks_until_abandoned_and_is_recovered_later() {
    let harness = Harness::start(|world| world.settle = Settle::Never).await;
    let plugin = harness.plugin_with(|config| config.preimage_timeout = Duration::from_millis(300));
    error_of(&harness.prompt(&plugin).await);
    let hash = harness.intents().keys().next().unwrap().clone();

    // While it is pending, no new payment for the model is made.
    let error = error_of(&harness.prompt(&plugin).await);
    assert!(error.contains("/intents abandon"), "{error}");
    assert_eq!(harness.sends(), 1);

    let listing = rpi_402::commands::run(&plugin, "").await;
    assert!(
        listing.contains(&hash) && listing.contains("blocks new payments"),
        "{listing}"
    );

    let answer = rpi_402::commands::run(&plugin, &format!("abandon {hash}")).await;
    assert!(answer.contains("no longer blocks"), "{answer}");
    assert_eq!(harness.intents()[&hash]["status"], "abandoned");

    // Abandoned, it no longer blocks; a new payment goes through.
    harness.world(|world| world.settle = Settle::Now);
    assert_served(&harness.prompt(&plugin).await);
    assert_eq!(harness.sends(), 2);

    // The abandoned payment settles after all and is recovered.
    complete(&harness.shared, &hash, false);
    let listing = rpi_402::commands::run(&plugin, "").await;
    assert!(listing.contains("recovered"), "{listing}");
    assert!(harness.intents().is_empty());
    assert_eq!(harness.receipts().len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_send_closes_its_intent() {
    let harness = Harness::start(|world| world.settle = Settle::Fail).await;
    let plugin = harness.plugin();
    let error = error_of(&harness.prompt(&plugin).await);
    assert!(error.contains("payment failed: no route"), "{error}");
    assert!(harness.intents().is_empty());
    harness.world(|world| world.settle = Settle::Now);
    assert_served(&harness.prompt(&plugin).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_wallet_is_created() {
    let harness = Harness::start(|world| world.exists = false).await;
    assert_served(&harness.prompt(&harness.plugin()).await);
    assert_eq!(harness.calls("/v1/wallet/create"), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_password_fails_without_creating_a_wallet() {
    let harness = Harness::start(|world| world.password = "something else".into()).await;
    let error = error_of(&harness.prompt(&harness.plugin()).await);
    assert!(error.contains("invalid passphrase"), "{error}");
    assert_eq!(harness.calls("/v1/wallet/create"), 0);
    assert_eq!(harness.sends(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lost_send_response_with_a_late_activity_row_pays_once() {
    // The wallet starts the payment, the HTTP response is lost, and the
    // activity row appears only after the plugin has looked for it.
    let harness = Harness::start(|world| {
        world.lose_send_response = true;
        world.row_delay = Duration::from_millis(300);
        world.settle = Settle::After(Duration::from_millis(200));
    })
    .await;
    let first = harness.plugin();
    let error = error_of(&harness.prompt(&first).await);
    assert!(error.contains("may have been sent"), "{error}");
    assert_eq!(
        harness.intents().len(),
        1,
        "the record survives the lost response"
    );

    // A second prompt in the same process is held back while the row is
    // still missing, and pays nothing.
    let error = error_of(&harness.prompt(&first).await);
    assert!(error.contains("/intents abandon"), "{error}");

    // After the payment settles, a restarted process recovers it.
    eventually("the payment to settle", || {
        harness.world(|world| {
            world
                .entries
                .iter()
                .any(|entry| entry["status"] == "ENTRY_STATUS_COMPLETE")
        })
    })
    .await;
    harness.world(|world| world.lose_send_response = false);
    let second = harness.plugin();
    assert_served(&harness.prompt(&second).await);
    assert_served(&harness.prompt(&second).await);
    assert_eq!(harness.sends(), 1, "exactly one send across the restart");
    assert_eq!(harness.receipts().len(), 1);
    assert!(harness.intents().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_quote_without_a_known_total_is_not_sent() {
    let harness = Harness::start(|world| world.total_known = false).await;
    let error = error_of(&harness.prompt(&harness.plugin()).await);
    assert!(
        error.contains("could not quote this payment's total"),
        "{error}"
    );
    assert_eq!(harness.calls("/v1/wallet/prepare-send"), 1);
    assert_eq!(harness.sends(), 0);
    assert!(harness.intents().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_credential_write_keeps_the_intent_for_recovery() {
    let harness = Harness::start(|_| {}).await;
    // A directory where tokens.json should be makes every token write fail.
    std::fs::create_dir_all(harness.dir.path().join("tokens.json")).unwrap();
    let plugin = harness.plugin();
    assert_served(&harness.prompt(&plugin).await);
    assert_eq!(harness.receipts().len(), 1);
    assert_eq!(
        harness.intents().len(),
        1,
        "kept until the credential is stored"
    );
    assert_eq!(
        plugin.counted_today().unwrap(),
        103.0,
        "counted once, through its receipt, not also through its reservation"
    );

    // Once the store works again, the next prompt recovers the recorded
    // payment instead of paying again.
    std::fs::remove_dir(harness.dir.path().join("tokens.json")).unwrap();
    assert_served(&harness.prompt(&plugin).await);
    assert_eq!(harness.sends(), 1);
    assert_eq!(
        harness.receipts().len(),
        1,
        "the receipt is not written twice"
    );
    assert_eq!(harness.token_keys().len(), 1);
    assert!(harness.intents().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unreadable_ledger_stops_payments() {
    let harness = Harness::start(|_| {}).await;
    std::fs::create_dir_all(harness.dir.path().join("receipts.ndjson")).unwrap();
    let error = error_of(&harness.prompt(&harness.plugin()).await);
    assert!(error.contains("today's spend is unknown"), "{error}");
    assert_eq!(harness.sends(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_processes_keep_every_payment_record() {
    // Two plugin instances share nothing but the data directory, like two
    // rpi processes. Whatever they pay, each send keeps its own record.
    for _ in 0..5 {
        let harness = Harness::start(|world| world.settle = Settle::Never).await;
        let short = |config: &mut Config| config.preimage_timeout = Duration::from_millis(300);
        let (a, b) = (harness.plugin_with(short), harness.plugin_with(short));
        let (first, second) = tokio::join!(harness.prompt(&a), harness.prompt(&b));
        error_of(&first);
        error_of(&second);
        assert!(harness.sends() >= 1);
        assert_eq!(
            harness.intents().len(),
            harness.sends(),
            "a send lost its record"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_upstream_402_keeps_a_good_credential() {
    let harness = Harness::start(|_| {}).await;
    let plugin = harness.plugin();
    assert_served(&harness.prompt(&plugin).await);

    // The model behind the seller answers 402 without an L402 challenge.
    harness.world(|world| world.upstream_402 = true);
    let error = error_of(&harness.prompt(&plugin).await);
    assert!(
        error.contains("http error 402") && error.contains("out of credit"),
        "{error}"
    );
    assert_eq!(harness.sends(), 1, "no new purchase");
    assert_eq!(harness.token_keys().len(), 1, "the credential is kept");

    harness.world(|world| world.upstream_402 = false);
    assert_served(&harness.prompt(&plugin).await);
    assert_eq!(harness.sends(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancel_while_the_activity_stream_opens_sends_nothing() {
    let harness = Harness::start(|world| world.subscribe_delay = Duration::from_millis(500)).await;
    let plugin = harness.plugin();
    let opts = SimpleStreamOptions::default();
    let signal = opts.signal.clone();
    let shared = harness.shared.clone();
    tokio::spawn(async move {
        loop {
            if shared
                .world
                .lock()
                .unwrap()
                .calls
                .iter()
                .any(|call| call == "/v1/wallet/subscribe")
            {
                signal.cancel();
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    });
    let message = harness.prompt_with(&plugin, &opts).await;
    assert!(
        matches!(message.stop_reason, StopReason::Aborted),
        "{:?}",
        message.stop_reason
    );
    // Give the payment task time to act after the stream would have opened.
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(harness.sends(), 0);
    assert!(harness.intents().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_wallet_enforces_a_fee_cap_and_the_receipt_records_the_settled_fee() {
    let harness = Harness::start(|world| world.fee_change_sat = 4).await;
    let plugin = harness.plugin_with(|config| config.daily_cap_sat = 150.0);
    assert_served(&harness.prompt(&plugin).await);
    let bodies = harness.world(|world| world.prepare_bodies.clone());
    assert_eq!(bodies.len(), 2);
    assert!(bodies[0].get("max_fee_sat").is_none());
    // 150 sat left today, 100 of it the invoice: the fee may reach 50.
    assert_eq!(bodies[1]["max_fee_sat"], 50);
    assert_eq!(
        harness.receipts()[0]["paidSat"],
        107,
        "the fee rose from 3 to 7 at dispatch"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_fee_rising_past_its_cap_is_refused_and_nothing_is_sent() {
    let harness = Harness::start(|world| world.fee_change_sat = 500).await;
    let plugin = harness.plugin_with(|config| config.daily_cap_sat = 150.0);
    let error = error_of(&harness.prompt(&plugin).await);
    assert!(error.contains("rose above its 50 sat cap"), "{error}");
    assert!(
        harness.world(|world| world.entries.is_empty()),
        "no payment started"
    );
    assert!(harness.receipts().is_empty());
    assert!(harness.intents().is_empty(), "the model is not blocked");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_payment_with_no_room_for_a_fee_is_refused() {
    // The invoice alone uses the whole remaining budget, and a zero cap
    // would mean the wallet's default fee.
    let harness = Harness::start(|world| world.fee_sat = 0).await;
    let plugin = harness.plugin_with(|config| config.daily_cap_sat = 100.0);
    let error = error_of(&harness.prompt(&plugin).await);
    assert!(error.contains("no room"), "{error}");
    assert_eq!(harness.sends(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_change_in_credit_does_not_change_the_cost() {
    // The second quote draws 30 sat more from the wallet, as when less
    // credit applies. Where the sats come from does not change what the
    // payment costs, which is what the limits and the receipt count.
    let harness = Harness::start(|world| world.quote_bump_sat = 30).await;
    let plugin = harness.plugin_with(|config| config.daily_cap_sat = 150.0);
    assert_served(&harness.prompt(&plugin).await);
    assert_eq!(harness.receipts()[0]["paidSat"], 103);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_falling_fee_is_recorded_as_settled() {
    // Quoted at a 20 sat fee, settled at 7.
    let harness = Harness::start(|world| {
        world.fee_sat = 20;
        world.fee_change_sat = -13;
    })
    .await;
    assert_served(&harness.prompt(&harness.plugin()).await);
    assert_eq!(harness.receipts()[0]["paidSat"], 107);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_fully_credit_funded_invoice_is_paid_and_counted_at_its_cost() {
    let harness = Harness::start(|world| {
        world.credit_funded = true;
        world.confirmed_sat = 0;
    })
    .await;
    assert_served(&harness.prompt(&harness.plugin()).await);
    assert_eq!(harness.sends(), 1);
    let receipt = &harness.receipts()[0];
    assert_eq!(receipt["paidSat"], 103, "the invoice plus the quoted fee");
    assert_eq!(receipt["amountSat"], 100);
}

#[tokio::test(flavor = "multi_thread")]
async fn credit_does_not_bypass_the_daily_limit() {
    let harness = Harness::start(|world| {
        world.credit_funded = true;
        world.confirmed_sat = 0;
    })
    .await;
    let plugin = harness.plugin_with(|config| config.daily_cap_sat = 100.0);
    let error = error_of(&harness.prompt(&plugin).await);
    assert!(error.contains("daily limit"), "{error}");
    assert_eq!(harness.sends(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unresolved_payment_reserves_its_fee_cap() {
    // 250 sat left today. The first payment quotes 103 sat but may take up
    // to 250 with its fee at the cap, so while unresolved it reserves 250.
    let harness = Harness::start(|world| world.settle = Settle::Never).await;
    let plugin = harness.plugin_with(|config| {
        config.daily_cap_sat = 250.0;
        config.preimage_timeout = Duration::from_millis(300);
    });
    error_of(&harness.prompt(&plugin).await);
    let hash = harness.intents().keys().next().unwrap().clone();
    assert_eq!(harness.intents()[&hash]["maxFeeSat"], 150);
    rpi_402::commands::run(&plugin, &format!("abandon {hash}")).await;
    let error = error_of(&harness.prompt(&plugin).await);
    assert!(error.contains("daily limit"), "{error}");
    assert_eq!(harness.sends(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_idle_wallet_without_history_can_pay() {
    // The wallet answers the subscribe call only after its first event.
    let harness = Harness::start(|world| world.idle_subscribe = true).await;
    assert_served(&harness.prompt(&harness.plugin()).await);
    assert_eq!(harness.sends(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_persistent_prompt_402_costs_one_probe() {
    let harness = Harness::start(|_| {}).await;
    let plugin = harness.plugin();
    assert_served(&harness.prompt(&plugin).await);
    // The seller serves the minimal probe but refuses the full prompt.
    harness.world(|world| world.prompt_402 = true);
    let error = error_of(&harness.prompt(&plugin).await);
    assert!(error.contains("http error 402"), "{error}");
    assert_eq!(
        harness.world(|world| world.served),
        2,
        "the first prompt and one probe"
    );
    assert_eq!(harness.sends(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_malformed_intent_stops_payments() {
    let harness = Harness::start(|_| {}).await;
    std::fs::create_dir_all(harness.dir.path().join("intents")).unwrap();
    std::fs::write(harness.dir.path().join("intents/ab.json"), "{ not json").unwrap();
    let error = error_of(&harness.prompt(&harness.plugin()).await);
    assert!(error.contains("ab.json"), "{error}");
    assert_eq!(harness.sends(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_partial_receipt_line_does_not_swallow_the_next_receipt() {
    let harness = Harness::start(|_| {}).await;
    std::fs::write(
        harness.dir.path().join("receipts.ndjson"),
        r#"{"paymentHash":"crashed","pai"#,
    )
    .unwrap();
    assert_served(&harness.prompt(&harness.plugin()).await);
    let ledger = rpi_402::store::ReceiptLog::new(harness.dir.path());
    assert_eq!(ledger.read_all().unwrap().len(), 1);
    assert!(harness.intents().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_passing_upstream_402_is_retried_once() {
    let harness = Harness::start(|_| {}).await;
    let plugin = harness.plugin();
    assert_served(&harness.prompt(&plugin).await);
    harness.world(|world| world.upstream_402_once = true);
    assert_served(&harness.prompt(&plugin).await);
    assert_eq!(harness.sends(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_credit_only_fee_comes_from_the_swap() {
    // The activity row of a credit-only payment carries "fee_sat": "0".
    let harness = Harness::start(|world| {
        world.credit_funded = true;
        world.confirmed_sat = 0;
        world.bundle_credit = 1;
    })
    .await;
    let plugin = harness.plugin_with(|config| config.daily_cap_sat = 203.0);
    assert_served(&harness.prompt(&plugin).await);
    assert_eq!(harness.receipts()[0]["paidSat"], 103);
    // 103 counted, 100 left: the next 103 sat purchase does not fit.
    let error = error_of(&harness.prompt(&plugin).await);
    assert!(error.contains("daily limit"), "{error}");
    assert_eq!(harness.sends(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn without_the_swap_a_zero_fee_counts_the_fee_cap() {
    let harness = Harness::start(|world| {
        world.credit_funded = true;
        world.confirmed_sat = 0;
        world.bundle_credit = 1;
        world.inspect_available = false;
    })
    .await;
    let plugin = harness.plugin_with(|config| config.daily_cap_sat = 203.0);
    assert_served(&harness.prompt(&plugin).await);
    // 203 sat left, so the fee cap was 103; the payment counts at most that.
    assert_eq!(harness.receipts()[0]["paidSat"], 203);
    let error = error_of(&harness.prompt(&plugin).await);
    assert!(error.contains("daily limit"), "{error}");
    assert_eq!(harness.sends(), 1);
}
