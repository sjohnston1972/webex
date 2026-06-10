export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.ok) return res.status === 204 ? (undefined as T) : res.json();
  let message = res.statusText;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    /* non-JSON error body */
  }
  throw new ApiError(message, res.status);
}

export const api = {
  get: <T = unknown>(path: string) => fetch(path).then((r) => handle<T>(r)),
  post: <T = unknown>(path: string, body?: unknown) =>
    fetch(path, {
      method: "POST",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then((r) => handle<T>(r)),
  put: <T = unknown>(path: string, body: unknown) =>
    fetch(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) =>
      handle<T>(r),
    ),
  patch: <T = unknown>(path: string, body: unknown) =>
    fetch(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) =>
      handle<T>(r),
    ),
  delete: <T = unknown>(path: string) => fetch(path, { method: "DELETE" }).then((r) => handle<T>(r)),
  upload: <T = unknown>(path: string, form: FormData) => fetch(path, { method: "POST", body: form }).then((r) => handle<T>(r)),
};

export type Project = {
  id: string;
  name: string;
  customer: string | null;
  webex_org_id: string | null;
  status: string;
  created_at: string;
  user_count?: number;
  cucm_linked?: number;
  webex_connected?: number;
};

export type Summary = {
  project: Project;
  counts: Record<string, number>;
  mappings: { confidence: string; n: number; selected: number }[];
  mappingsByType: { target_type: string; n: number; selected: number }[];
  unattachedDns: number;
  batches: { id: string; name: string; status: string; created_at: string }[];
  snapshots: {
    id: string;
    type: string;
    source: string;
    status: string;
    counts_json: string | null;
    error_text: string | null;
    created_at: string;
    parsed_at: string | null;
  }[];
  axl: { base_url: string; username: string; cucm_version: string | null; verified_at: string | null } | null;
  unity: { base_url: string; username: string; unity_version: string | null; verified_at: string | null } | null;
  webex: { org_id: string | null; org_name: string | null; expires_at: string; updated_at: string } | null;
};

export type Mapping = {
  id: string;
  src_type: string;
  src_id: string;
  target_type: string;
  target_payload: string;
  status: string;
  selected: number;
  confidence: "green" | "amber" | "red";
  notes: string | null;
};

export type BatchItem = {
  id: string;
  mapping_id: string;
  src_type: string;
  target_type: string;
  target_payload: string;
  confidence: string;
  mapping_notes: string | null;
  validate_status: string | null;
  validate_notes: string | null;
  push_status: string;
  webex_resource_id: string | null;
  error_text: string | null;
};

export type Batch = { id: string; name: string; status: string; created_at: string };
