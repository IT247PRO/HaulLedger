import { HTTPException } from 'hono/http-exception';

/** Calls a vendor API and turns failures into clear 502s (never a silent empty result). */
export async function vendorJson<T>(vendor: string, url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new HTTPException(502, { message: `${vendor} could not be reached: ${(err as Error).message}` });
  }
  if (res.status === 401 || res.status === 403) throw new HTTPException(502, { message: `${vendor} rejected the credentials (${res.status}). Check them in Integrations.` });
  if (!res.ok) throw new HTTPException(502, { message: `${vendor} returned ${res.status}` });
  try {
    return (await res.json()) as T;
  } catch {
    throw new HTTPException(502, { message: `${vendor} returned a response that is not JSON` });
  }
}
