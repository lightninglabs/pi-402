// formatSat groups the digits of a sat amount for display ("58,000").
export function formatSat(sat: number): string {
	return sat.toLocaleString("en-US");
}
