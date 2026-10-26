import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { S3Client, PutObjectCommand, GetObjectCommand } from "npm:@aws-sdk/client-s3@3.750.0";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@3.750.0";

const corsHeaders = {
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Content-Type": "application/json",
};
function respond(status: number, body: Record<string, unknown>, origin: string) {
  let allowed = "";
  try {
    const url = new URL(origin);
    if (url.protocol === "https:" && (url.hostname === "rpcalls.vercel.app" || url.hostname.endsWith(".vercel.app"))) allowed = origin;
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") allowed = origin;
  } catch { /* no origin */ }
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Access-Control-Allow-Origin": allowed, Vary: "Origin" } });
}
const jsonError = (status: number, error: string, origin: string) => respond(status, { success: false, error }, origin);
const validMeetingId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
async function hashToken(token: string) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") return new Response("ok", { headers: { ...corsHeaders, "Access-Control-Allow-Origin": origin, Vary: "Origin" } });
  if (req.method !== "POST") return jsonError(405, "Use POST.", origin);
  try {
    const projectUrl = Deno.env.get("SUPABASE_URL");
    const secretsRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
    const secrets = secretsRaw ? JSON.parse(secretsRaw) : {};
    const serviceKey = secrets.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const endpointRaw = Deno.env.get("B2_ENDPOINT")?.trim();
    const endpoint = endpointRaw ? (/^https?:\/\//i.test(endpointRaw) ? endpointRaw : `https://${endpointRaw}`) : "";
    const bucket = Deno.env.get("B2_BUCKET_NAME")?.trim();
    const keyId = Deno.env.get("B2_KEY_ID")?.trim();
    const applicationKey = Deno.env.get("B2_APPLICATION_KEY")?.trim();
    if (!projectUrl || !serviceKey) return jsonError(503, "Supabase server credentials are not configured.", origin);
    if (!endpoint || !bucket || !keyId || !applicationKey) return jsonError(503, "Backblaze B2 credentials are not configured for RPcalls recording.", origin);
    const endpointUrl = new URL(endpoint);
    if (endpointUrl.protocol !== "https:" || !endpointUrl.hostname.endsWith(".backblazeb2.com") || endpointUrl.username || endpointUrl.password) return jsonError(503, "B2_ENDPOINT must be a valid HTTPS Backblaze S3 endpoint.", origin);
    const region = endpointUrl.hostname.match(/^s3[.-]([a-z0-9-]+)\.backblazeb2\.com$/i)?.[1] || "us-east-1";
    const admin = createClient(projectUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const s3 = new S3Client({ region, endpoint: endpointUrl.origin, forcePathStyle: true, credentials: { accessKeyId: keyId, secretAccessKey: applicationKey } });

    const body = await req.json();
    const action = String(body.action || "");
    const meetingId = body.meetingId;
    const hostToken = typeof body.hostToken === "string" ? body.hostToken : "";
    if (!validMeetingId(meetingId) || hostToken.length < 32 || hostToken.length > 256) return jsonError(400, "Invalid meeting or host recording key.", origin);
    const tokenHash = await hashToken(hostToken);

    if (action === "start") {
      const title = String(body.title || "RPcalls meeting").trim().slice(0, 120) || "RPcalls meeting";
      const startedAt = typeof body.startedAt === "string" && Number.isFinite(Date.parse(body.startedAt)) ? new Date(body.startedAt).toISOString() : new Date().toISOString();
      const { data: existing, error: readError } = await admin.from("rpcalls_recordings").select("host_token_hash,status").eq("meeting_id", meetingId).maybeSingle();
      if (readError) return jsonError(500, "Could not check recording metadata.", origin);
      if (existing && existing.host_token_hash !== tokenHash) return jsonError(403, "This meeting recording is already registered to a different host key.", origin);
      if (!existing) {
        const { error } = await admin.from("rpcalls_recordings").insert({ meeting_id: meetingId, title, started_at: startedAt, status: "recording", host_token_hash: tokenHash });
        if (error) return jsonError(500, "Could not register the meeting recording. Apply the RPcalls recording migration first.", origin);
      }
      return respond(200, { success: true, status: "recording" }, origin);
    }

    const { data: row, error: rowError } = await admin.from("rpcalls_recordings").select("host_token_hash,status").eq("meeting_id", meetingId).maybeSingle();
    if (rowError) return jsonError(500, "Could not read recording metadata.", origin);
    if (!row || row.host_token_hash !== tokenHash) return jsonError(403, "The host recording key could not be verified.", origin);

    if (action === "upload-url") {
      const size = Number(body.size);
      const contentType = String(body.contentType || "video/webm").slice(0, 120);
      if (!Number.isSafeInteger(size) || size < 1 || size > 4 * 1024 * 1024 * 1024) return jsonError(413, "Recording must be between 1 byte and 4 GB.", origin);
      const objectPath = `rpcalls/recordings/${meetingId}/meeting-${meetingId}.webm`;
      const command = new PutObjectCommand({ Bucket: bucket, Key: objectPath, ContentType: contentType });
      const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 });
      const { error } = await admin.from("rpcalls_recordings").update({ status: "uploading", object_path: objectPath, content_type: contentType, size_bytes: size, updated_at: new Date().toISOString() }).eq("meeting_id", meetingId);
      if (error) return jsonError(500, "Could not update recording metadata.", origin);
      return respond(200, { success: true, uploadUrl, objectPath }, origin);
    }

    if (action === "complete") {
      const objectPath = String(body.objectPath || "");
      const size = Number(body.size);
      if (objectPath !== `rpcalls/recordings/${meetingId}/meeting-${meetingId}.webm` || !Number.isSafeInteger(size) || size < 1 || size > 4 * 1024 * 1024 * 1024) return jsonError(400, "Recording completion metadata is invalid; recordings are limited to 4 GB.", origin);
      const endedAt = typeof body.endedAt === "string" && Number.isFinite(Date.parse(body.endedAt)) ? new Date(body.endedAt).toISOString() : new Date().toISOString();
      const { error } = await admin.from("rpcalls_recordings").update({ status: "saved", object_path: objectPath, size_bytes: size, content_type: String(body.contentType || "video/webm").slice(0, 120), ended_at: endedAt, updated_at: new Date().toISOString() }).eq("meeting_id", meetingId);
      if (error) return jsonError(500, "The B2 upload completed, but Supabase could not save the recording status.", origin);
      return respond(200, { success: true, status: "saved", objectPath }, origin);
    }
    return jsonError(400, "Unsupported recording action.", origin);
  } catch (error) {
    console.error("[rpcalls-recording] failed", error);
    return jsonError(500, error instanceof Error ? error.message : "Unexpected recording service error.", origin);
  }
});
