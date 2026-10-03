// Conservative checks for recognizable key material, not a general secret,
// provenance or malware scanner.
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
];
export function containsKnownCredential(bytes) {
  const text = new TextDecoder().decode(bytes);
  return patterns.some(pattern => pattern.test(text));
}
