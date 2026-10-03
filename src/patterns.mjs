// Shared schema/runtime expression. Numeric SemVer prerelease identifiers cannot have leading zeroes.
export const SEMVER_PATTERN = '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$';

// Win32 also recognizes the ISO-8859-1 superscript digits in COM/LPT names.
export const WINDOWS_DEVICE_COMPONENT = /^(?:CON|CONIN\$|CONOUT\$|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i;
const privateComponent = /^(?:\.git(?:-credentials)?|\.hg|\.svn|\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|_netrc|\.aws|\.azure|\.ssh|\.gnupg|\.kube|\.docker|id_(?:rsa|dsa|ecdsa(?:_sk)?|ed25519(?:_sk)?))$/i;
const privateExtension = /\.(?:pem|key|p12|pfx)$/i;
export const isPrivateFileComponent = value => typeof value !== 'string' || privateComponent.test(value) || privateExtension.test(value);
