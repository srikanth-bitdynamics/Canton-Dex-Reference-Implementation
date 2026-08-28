// Runtime credentials for the operator HTTP API.
//
// These tokens are deliberately NOT Vite environment variables: VITE_* values
// are compiled into the public JavaScript bundle. An operator or validator may
// enter short-lived credentials in the Admin screen; they live only in this
// browser tab's sessionStorage and are attached to write requests.
//
// A public/multi-user deployment should replace this manual handoff with its
// own authenticated BFF/session issuer. Never distribute a shared long-lived
// operator or admin token to ordinary traders.

const OPERATOR_TOKEN_KEY = "canton-dex.operator-api-token";
const ADMIN_TOKEN_KEY = "canton-dex.admin-api-token";
const CALLER_TOKEN_KEY = "canton-dex.caller-token";

export interface ApiSessionCredentials {
  operatorToken: string;
  adminToken: string;
  callerToken: string;
}

function session(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    // Storage can be disabled by browser policy. Reads remain available and
    // the backend still fails closed for protected writes.
    return null;
  }
}

function read(key: string): string {
  try {
    return session()?.getItem(key)?.trim() ?? "";
  } catch {
    return "";
  }
}

function write(key: string, value: string): void {
  const storage = session();
  if (!storage) return;
  try {
    const normalized = value.trim();
    if (normalized) storage.setItem(key, normalized);
    else storage.removeItem(key);
  } catch {
    // A privacy policy or exhausted quota can reject the write. The backend
    // remains fail-closed; no credential is moved to a less-safe fallback.
  }
}

export function getApiSessionCredentials(): ApiSessionCredentials {
  return {
    operatorToken: read(OPERATOR_TOKEN_KEY),
    adminToken: read(ADMIN_TOKEN_KEY),
    callerToken: read(CALLER_TOKEN_KEY),
  };
}

export function setApiSessionCredentials(
  credentials: ApiSessionCredentials,
): void {
  write(OPERATOR_TOKEN_KEY, credentials.operatorToken);
  write(ADMIN_TOKEN_KEY, credentials.adminToken);
  write(CALLER_TOKEN_KEY, credentials.callerToken);
}

export function clearApiSessionCredentials(): void {
  const storage = session();
  try {
    storage?.removeItem(OPERATOR_TOKEN_KEY);
    storage?.removeItem(ADMIN_TOKEN_KEY);
    storage?.removeItem(CALLER_TOKEN_KEY);
  } catch {
    // Treat unavailable storage as already cleared from the app's point of
    // view. Reads return empty strings and protected requests carry no token.
  }
}

/** Headers required by the backend's fail-closed write and private-read gates. */
export function apiAuthHeaders(
  path: string,
  method = "GET",
): Record<string, string> {
  const normalizedMethod = method.toUpperCase();
  const credentials = getApiSessionCredentials();
  if (["GET", "HEAD", "OPTIONS"].includes(normalizedMethod)) {
    return credentials.callerToken
      ? { "X-Caller-Token": credentials.callerToken }
      : {};
  }
  const bearer = path.startsWith("/v1/admin/")
    ? credentials.adminToken
    : credentials.operatorToken;
  return {
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    ...(credentials.callerToken
      ? { "X-Caller-Token": credentials.callerToken }
      : {}),
  };
}
