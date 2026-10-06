/**
 * Derive a readable display name from a Strata model id.
 *
 * Strata model ids look like `swift-1.5-iq3_xxs` or `qwen3.8-flash-next-q2_0`.
 * We split on hyphens, keep numeric dots intact, and render quantizer tokens
 * (underscore-joined) in the usual upper-case style.
 *
 * Examples:
 *   `swift-1.5-iq3_xxs`            -> `Swift 1.5 IQ3_XXS`
 *   `qwen3.8-flash-next-q2_0`      -> `Qwen3.8 Flash Next Q2_0`
 */
export function humanizeModelId(id: string): string {
	const segments = String(id).split("-");
	const parts: string[] = [];
	for (const segment of segments) {
		if (!segment) {
			continue;
		}
		const underscoreParts = segment.split("_").filter((s) => s.length > 0);
		if (underscoreParts.length > 1) {
			// Quantizer-style token (e.g. iq3_xxs, q2_0). Uppercase each part.
			parts.push(underscoreParts.map((p) => p.toUpperCase()).join("_"));
		} else {
			parts.push(capitalizeToken(segment));
		}
	}
	return parts.join(" ");
}

/** Capitalize the first alphabetic character of a token, leaving the rest unchanged. */
function capitalizeToken(token: string): string {
	if (!token) {
		return token;
	}
	if (/[A-Za-z]/.test(token[0])) {
		return token[0].toUpperCase() + token.slice(1);
	}
	return token;
}