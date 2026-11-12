// FOOTER_POLL_MS is how often the footer re-reads a balance that came back as
// zero, and FOOTER_POLL_ATTEMPTS bounds how many times it does. The embedded
// wallet reports ready before its first sync finishes, so a read taken right
// after unlock can see zero for a wallet that holds funds. Thirty seconds
// covers a normal sync; a wallet that is still empty after that is empty.
export const FOOTER_POLL_MS = 2_000;
export const FOOTER_POLL_ATTEMPTS = 15;

// refreshWhileEmpty re-reads the balance until it is non-zero, calling show on
// each read, and stops after the attempt bound. A failed read counts as an
// attempt and leaves the last footer in place. The first read is the caller's
// own, so this only covers the window after it.
export async function refreshWhileEmpty(
	read: () => Promise<number>,
	show: (balanceSat: number) => void,
	pollMs = FOOTER_POLL_MS,
	attempts = FOOTER_POLL_ATTEMPTS,
): Promise<void> {
	for (let i = 0; i < attempts; i++) {
		await new Promise<void>((resolve) => setTimeout(resolve, pollMs).unref());
		try {
			const balance = await read();
			show(balance);
			if (balance > 0) {
				return;
			}
		} catch {
			// Try again on the next tick.
		}
	}
}
