import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, ArrowLeft, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Copy,
  Headphones, Link2, MessageCircle, Mic, MicOff, MonitorUp, MoreHorizontal,
  Plus, Send, Settings2, ShieldCheck, Sparkles, Users, Video, VideoOff, Wifi,
  X, PhoneOff, Share2, CalendarClock, CalendarDays, UserRoundPlus, PanelRight, Volume2,
  FolderOpen, Paperclip, UserCheck, UserX, Clock3, Palette, Camera, FileUp,
} from "lucide-react";
import { realtimeConfigured, supabase } from "./lib/supabase";

type PresencePerson = {
  peerId: string;
  name: string;
  isHost?: boolean;
  admitted?: boolean;
  micOn?: boolean;
  cameraOn?: boolean;
  raised?: boolean;
  joinedAt?: number;
};
type MeetingEntry = {
  id: string;
  title: string;
  startAt: number;
  createdAt: number;
  status: "scheduled" | "started" | "ended";
  mode: "meeting";
};
type BackgroundEffect = "none" | "blur" | "studio" | "warm";
type FileTransfer = { id: string; name: string; size: number; received: number; status: "receiving" | "saved" | "downloaded" | "error"; direction: "sent" | "received"; peerName?: string };
type ChatMessage = { id: string; from: string; name: string; text: string; sentAt: number };
type Panel = "chat" | "people";

const randomId = (bytes = 20) => {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, (v) => v.toString(16).padStart(2, "0")).join("");
};
const hostStorageKey = (id: string) => `rpcalls:host:${id}`;
const safeName = (value: string) => value.trim().slice(0, 50);
const localDateValue = (date: Date) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};
const defaultMeetingDate = () => localDateValue(new Date(Date.now() + 30 * 60000));
const defaultMeetingTime = () => {
  const date = new Date(Date.now() + 30 * 60000);
  const mins = Math.ceil(date.getMinutes() / 15) * 15;
  date.setMinutes(mins, 0, 0);
  return `${String(date.getHours()).padStart(2,"0")}:${String(date.getMinutes()).padStart(2,"0")}`;
};
const safeFileName = (value: string) => value.replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "").slice(0, 160) || "shared-file";
const timeLabel = (value: number) => new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function VideoTile({
  name, stream, muted = false, cameraOn = true, local = false, isHost = false,
}: {
  name: string;
  stream?: MediaStream | null;
  muted?: boolean;
  cameraOn?: boolean;
  local?: boolean;
  isHost?: boolean;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream || null;
    if (stream) void video.play().catch(() => undefined);
  }, [stream]);
  const hasVideo = Boolean(stream?.getVideoTracks().some((track) => track.readyState === "live") && cameraOn);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
  return (
    <article className={`videoTile ${local ? "isLocal" : ""} ${hasVideo ? "hasVideo" : ""}`}>
      <video ref={ref} autoPlay playsInline muted={muted} className={hasVideo ? "" : "audioOnlyVideo"} />
      {!hasVideo && (
        <div className="videoAvatarStage">
          <div className="videoAvatar">{initials}</div>
          <span>{cameraOn ? "Camera off" : "Camera off"}</span>
        </div>
      )}
      <div className="tileOverlay">
        <div className="tileName"><span className={`presenceDot ${stream ? "online" : ""}`} />{name}{local ? " (You)" : ""}{isHost && <span className="hostPill">Organizer</span>}</div>
        <div className="tileStatus">
          {!stream?.getAudioTracks().some((track) => track.enabled) && <span title="Microphone muted"><MicOff size={13} /></span>}
        </div>
      </div>
    </article>
  );
}

export function App() {
  const initialParams = new URLSearchParams(window.location.search);
  const initialRoom = initialParams.get("meeting") || initialParams.get("chat");
  const initialRoomMode: "meeting" | "chat" = initialParams.has("chat") && !initialParams.has("meeting") ? "chat" : "meeting";
  const [roomId, setRoomId] = useState<string | null>(initialRoom);
  const [roomMode, setRoomMode] = useState<"meeting" | "chat">(initialRoomMode);
  const [joined, setJoined] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [isAdmitted, setIsAdmitted] = useState(false);
  const [joinDenied, setJoinDenied] = useState(false);
  const [meetingTitle, setMeetingTitle] = useState(() => initialParams.get("title") || "RPcalls meeting");
  const [showCreateMeeting, setShowCreateMeeting] = useState(false);
  const [newMeetingTitle, setNewMeetingTitle] = useState("");
  const [newMeetingDate, setNewMeetingDate] = useState(defaultMeetingDate);
  const [newMeetingTime, setNewMeetingTime] = useState(defaultMeetingTime);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [calendarItems, setCalendarItems] = useState<MeetingEntry[]>(() => {
    try { return JSON.parse(localStorage.getItem("rpcalls:calendar:v1") || "[]") as MeetingEntry[]; } catch { return []; }
  });
  const [backgroundEffect, setBackgroundEffect] = useState<BackgroundEffect>("none");
  const [backgroundBusy, setBackgroundBusy] = useState(false);
  const [fileTransfers, setFileTransfers] = useState<FileTransfer[]>([]);
  const [autoSaveFolderName, setAutoSaveFolderName] = useState("");
  const [autoSaveSupported, setAutoSaveSupported] = useState(false);
  const [displayName, setDisplayName] = useState(() => {
    try { return localStorage.getItem("rpcalls:name") || ""; } catch { return ""; }
  });
  const [peerId, setPeerId] = useState("");
  const [participants, setParticipants] = useState<PresencePerson[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [activePanel, setActivePanel] = useState<Panel>("chat");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [muted, setMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(true);
  const [joinMicOn, setJoinMicOn] = useState(true);
  const [joinCameraOn, setJoinCameraOn] = useState(true);
  const [raised, setRaised] = useState(false);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [connectionState, setConnectionState] = useState("Ready");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [mediaWarning, setMediaWarning] = useState("");
  const [recordingStatus, setRecordingStatus] = useState<"off" | "starting" | "recording" | "uploading" | "saved" | "error">("off");
  const [recordingError, setRecordingError] = useState("");
  const recordingStartedRoomRef = useRef<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const stopRecordingRef = useRef<(() => Promise<void>) | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [meetingTab, setMeetingTab] = useState<"overview" | "meetings">("overview");
  const [chatSearch, setChatSearch] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [turnHelp, setTurnHelp] = useState(false);
  const [iceServersDraft, setIceServersDraft] = useState("");
  const [chatUnread, setChatUnread] = useState(0);
  const [authUser, setAuthUser] = useState<{ id: string; email?: string } | null>(null);
  const [authStatus, setAuthStatus] = useState<"loading" | "signed-out" | "active" | "inactive">("loading");
  const [authInitialized, setAuthInitialized] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authDisplayName, setAuthDisplayName] = useState("");

  // Generate a fresh, subtle Bauhaus composition for each successful workspace login.
  useEffect(() => {
    if (authStatus !== "active") return;
    const root = document.documentElement;
    const pick = (values: string[]) => values[Math.floor(Math.random() * values.length)];
    root.style.setProperty("--bauhaus-red-x", pick(["11%", "17%", "23%", "29%", "36%", "42%", "58%", "67%", "76%"]));
    root.style.setProperty("--bauhaus-red-y", pick(["14%", "22%", "34%", "48%", "61%", "73%", "82%"]));
    root.style.setProperty("--bauhaus-blue-x", pick(["62%", "69%", "77%", "84%", "91%"]));
    root.style.setProperty("--bauhaus-blue-y", pick(["24%", "39%", "53%", "67%", "79%", "88%"]));
    root.style.setProperty("--bauhaus-yellow-x", pick(["24%", "38%", "51%", "66%", "73%", "87%"]));
    root.style.setProperty("--bauhaus-yellow-y", pick(["12%", "19%", "31%", "44%", "57%", "71%", "84%"]));
    root.style.setProperty("--bauhaus-drift-x", pick(["-.9%", "-.5%", ".7%", "1.1%", "1.5%", "2%"]));
    root.style.setProperty("--bauhaus-drift-y", pick(["-.8%", "-.3%", ".4%", ".8%", "1.2%"]));
    root.style.setProperty("--bauhaus-rotation", pick(["-.45deg", "-.25deg", ".2deg", ".35deg", ".5deg"]));
    root.style.setProperty("--bauhaus-duration", pick(["29s", "33s", "37s", "41s", "46s"]));
    root.style.setProperty("--bauhaus-grid-size", pick(["44px", "48px", "52px", "58px", "64px"]));
    root.style.setProperty("--bauhaus-grid-opacity", pick([".20", ".23", ".26", ".29"]));
  }, [authStatus]);

  const channelRef = useRef<any>(null);
  const peerIdRef = useRef("");
  const identityRef = useRef<{ peerId: string; name: string; isHost: boolean }>({ peerId: "", name: "", isHost: false });
  const presenceRef = useRef({ micOn: true, cameraOn: true, raised: false, admitted: false });
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const pcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const makingOfferRef = useRef<Set<string>>(new Set());
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const fileChooserRef = useRef<HTMLInputElement | null>(null);
  const fileSendInputRef = useRef<HTMLInputElement | null>(null);
  const hostPeerIdRef = useRef("");
  const isAdmittedRef = useRef(false);
  const dataChannelsRef = useRef<Map<string, RTCDataChannel>>(new Map());
  const incomingFilesRef = useRef<Map<string, any>>(new Map());
  const saveDirectoryHandleRef = useRef<any>(null);
  const backgroundProcessorRef = useRef<any>(null);
  const processedVideoStreamRef = useRef<MediaStream | null>(null);
  const [processedVideoStream, setProcessedVideoStream] = useState<MediaStream | null>(null);

  useEffect(() => {
    if (roomId) {
      let savedHost = false;
      try { savedHost = Boolean(sessionStorage.getItem(hostStorageKey(roomId))); } catch { /* restricted storage */ }
      setIsHost(savedHost);
    }
  }, [roomId]);

  // RPcalls uses the same Supabase Auth project and profile records as RPportal.
  useEffect(() => {
    if (!supabase) {
      setAuthUser(null);
      setAuthStatus("signed-out");
      return;
    }
    let mounted = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (mounted) {
        setAuthUser(data.session?.user ? { id: data.session.user.id, email: data.session.user.email } : null);
        setAuthInitialized(true);
      }
    }).catch(() => {
      if (mounted) {
        setAuthUser(null);
        setAuthInitialized(true);
      }
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (mounted) {
        setAuthUser(session?.user ? { id: session.user.id, email: session.user.email } : null);
        setAuthInitialized(true);
      }
    });
    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  // Consume the short-lived, single-use Supabase SSO token immediately and remove it from the address bar.
  useEffect(() => {
    if (!supabase) return;
    const params = new URLSearchParams(window.location.search);
    const tokenHash = params.get("sso_token_hash");
    const tokenType = params.get("sso_type");
    if (!tokenHash || tokenType !== "magiclink") return;
    params.delete("sso_token_hash");
    params.delete("sso_type");
    const cleaned = window.location.pathname + (params.toString() ? "?" + params.toString() : "") + window.location.hash;
    window.history.replaceState(null, "", cleaned);
    void supabase.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" }).then(({ error }) => {
      if (error) setAuthError("Your sign-in handoff expired or was already used. Open RPportal and try again.");
    });
  }, []);

  // Do not automatically bounce signed-out visitors between the two apps.
  // Keep the sign-in gate visible; users can explicitly continue through RPportal SSO.
  
  // Reverse handoff: if an employee is already signed into RPcalls, allow RPportal to reuse that identity.
  useEffect(() => {
    if (authStatus !== "active" || !authUser || !supabase) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("sso") !== "rpportal") return;
    params.delete("sso");
    window.history.replaceState(null, "", window.location.pathname + (params.toString() ? "?" + params.toString() : "") + window.location.hash);
    void supabase.functions.invoke("rp-sso-handoff", { body: { target: "rpportal" } }).then(({ data, error }) => {
      if (error || !data?.redirectUrl) {
        setAuthError("Could not securely open RPportal. Please retry.");
        return;
      }
      window.location.replace(data.redirectUrl);
    }).catch(() => setAuthError("Could not securely open RPportal. Please retry."));
  }, [authStatus, authUser]);

  useEffect(() => {
    if (!supabase) {
      setAuthStatus("signed-out");
      return;
    }
    if (!authUser) {
      setAuthStatus("signed-out");
      setAuthDisplayName("");
      return;
    }
    let cancelled = false;
    setAuthStatus("loading");
    void supabase
      .from("profiles")
      .select("display_name, is_active")
      .eq("id", authUser.id)
      .maybeSingle()
      .then(async ({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setAuthStatus("inactive");
          setAuthError("We couldn't verify your RPportal account. Check your connection or contact the RPportal administrator.");
          return;
        }
        if (!data || data.is_active !== true) {
          setAuthStatus("inactive");
          setAuthError("This login does not have an active RPportal user profile. Ask an administrator to activate your account.");
          void supabase?.auth.signOut();
          return;
        }
        setAuthStatus("active");
        setAuthError("");
        const profileName = (data.display_name || authUser.email?.split("@")[0] || "RPportal user").trim();
        setAuthDisplayName(profileName);
        setDisplayName((current) => current.trim() ? current : profileName);
      });
    return () => { cancelled = true; };
  }, [authUser]);

  useEffect(() => {
    try {
      if (displayName.trim()) localStorage.setItem("rpcalls:name", displayName.trim());
    } catch { /* storage is optional */ }
  }, [displayName]);

  useEffect(() => {
    try { localStorage.setItem("rpcalls:calendar:v1", JSON.stringify(calendarItems)); }
    catch { /* Calendar remains available for this session when storage is blocked. */ }
  }, [calendarItems]);

  useEffect(() => {
    setAutoSaveSupported(typeof (window as any).showDirectoryPicker === "function");
  }, []);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, activePanel]);

  const turnServers = useMemo<RTCIceServer[]>(() => {
    const urls = (import.meta.env.VITE_TURN_URLS || "").split(",").map((value) => value.trim()).filter(Boolean);
    const servers: RTCIceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
    if (urls.length && import.meta.env.VITE_TURN_USERNAME && import.meta.env.VITE_TURN_CREDENTIAL) {
      servers.push({ urls, username: import.meta.env.VITE_TURN_USERNAME, credential: import.meta.env.VITE_TURN_CREDENTIAL });
    }
    return servers;
  }, []);

  const notify = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice(""), 3600);
  };

  const handleRPportalLogin = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase) {
      setAuthError("RPcalls authentication is not configured. Contact the administrator.");
      return;
    }
    setAuthBusy(true);
    setAuthError("");
    const { error } = await supabase.auth.signInWithPassword({
      email: authEmail.trim(),
      password: authPassword,
    });
    if (error) setAuthError("Sign-in failed. Check your RPportal email and password, then try again.");
    setAuthBusy(false);
  };

  const currentRoomLink = (id = roomId, mode: "meeting" | "chat" = roomMode, title = meetingTitle) => {
    if (!id) return window.location.origin;
    const params = new URLSearchParams({ [mode === "chat" ? "chat" : "meeting"]: id });
    if (mode === "meeting" && title.trim()) params.set("title", title.trim());
    return `${window.location.origin}/?${params.toString()}`;
  };

  const trackPresence = async (patch: Partial<typeof presenceRef.current> = {}) => {
    presenceRef.current = { ...presenceRef.current, ...patch };
    const channel = channelRef.current;
    const person = identityRef.current;
    if (!channel || !person.peerId) return;
    try {
      await channel.track({
        peerId: person.peerId,
        name: person.name,
        isHost: person.isHost,
        ...presenceRef.current,
        joinedAt: Date.now(),
      });
    } catch { /* reconnecting */ }
  };

  const sendSignal = async (payload: Record<string, unknown>) => {
    const channel = channelRef.current;
    const from = peerIdRef.current;
    if (!channel || !from) return;
    try {
      await channel.send({
        type: "broadcast",
        event: "signal",
        payload: { ...payload, from },
      });
    } catch (error) {
      console.warn("RPcalls signal send failed", error);
    }
  };

  const refreshParticipants = (channel: any) => {
    const raw = channel.presenceState() as Record<string, PresencePerson[]>;
    const collected = Object.values(raw).flat().filter((person) => person && person.peerId);
    const unique = new Map<string, PresencePerson>();
    collected.forEach((person) => unique.set(person.peerId, person));
    const list = Array.from(unique.values()).sort((a, b) => {
      if (a.peerId === peerIdRef.current) return -1;
      if (b.peerId === peerIdRef.current) return 1;
      return (a.joinedAt || 0) - (b.joinedAt || 0);
    });
    setParticipants(list);
    const host = list.find((person) => person.isHost && person.admitted !== false);
    hostPeerIdRef.current = host?.peerId || (identityRef.current.isHost ? peerIdRef.current : "");
    for (const person of list) {
      if (isAdmittedRef.current && person.peerId !== peerIdRef.current && person.admitted !== false && peerIdRef.current.localeCompare(person.peerId) < 0) {
        void makeOffer(person.peerId);
      }
    }
  };

  const applyPendingIce = async (remoteId: string, pc: RTCPeerConnection) => {
    const pending = pendingIceRef.current.get(remoteId) || [];
    pendingIceRef.current.delete(remoteId);
    for (const candidate of pending) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (error) { console.debug("Skipped stale ICE candidate", error); }
    }
  };

  const bindDataChannel = (remoteId: string, dataChannel: RTCDataChannel) => {
    dataChannel.binaryType = "arraybuffer";
    dataChannel.bufferedAmountLowThreshold = 256 * 1024;
    dataChannelsRef.current.set(remoteId, dataChannel);
    dataChannel.onopen = () => notify("Direct file sharing is ready.");
    dataChannel.onclose = () => {
      if (dataChannelsRef.current.get(remoteId) === dataChannel) dataChannelsRef.current.delete(remoteId);
    };
    dataChannel.onerror = () => notify("A direct file-sharing connection had an error.");
    dataChannel.onmessage = (event) => { void handleIncomingFileMessage(remoteId, event); };
  };

  const handleIncomingFileMessage = async (remoteId: string, event: MessageEvent) => {
    const transfer = incomingFilesRef.current.get(remoteId);
    if (typeof event.data === "string") {
      let message: any;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.kind === "file-start" && message.id && message.name) {
        const id = String(message.id);
        const name = safeFileName(String(message.name));
        let writable: any = null;
        if (identityRef.current.isHost && saveDirectoryHandleRef.current) {
          try {
            const handle = await saveDirectoryHandleRef.current.getFileHandle(name, { create: true });
            writable = await handle.createWritable();
          } catch (error) {
            console.warn("RPcalls auto-save could not create file", error);
            notify("Could not create the auto-save file. The browser may have revoked folder access.");
          }
        }
        incomingFilesRef.current.set(remoteId, {
          id, name, size: Number(message.size) || 0, type: String(message.type || "application/octet-stream"),
          received: 0, chunks: [], writable, peerName: String(message.fromName || "Participant"),
        });
        setFileTransfers((current) => [...current.filter((item) => item.id !== id), {
          id, name, size: Number(message.size) || 0, received: 0, status: "receiving",
          direction: "received", peerName: String(message.fromName || "Participant"),
        }]);
        if (identityRef.current.isHost && !writable) notify("File incoming. Choose an auto-save folder to save future files without a prompt.");
        return;
      }
      if (message.kind === "file-end" && transfer) {
        try {
          if (transfer.writable) {
            await transfer.writable.close();
            setFileTransfers((current) => current.map((item) => item.id === transfer.id ? { ...item, received: transfer.received, status: "saved" } : item));
            notify(`Saved ${transfer.name} to the selected folder.`);
          } else {
            const blob = new Blob(transfer.chunks, { type: transfer.type });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = transfer.name;
            anchor.style.display = "none";
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 60000);
            setFileTransfers((current) => current.map((item) => item.id === transfer.id ? { ...item, received: transfer.received, status: "downloaded" } : item));
            notify(`File received: ${transfer.name}. Check your browser downloads.`);
          }
        } catch (error) {
          console.error("RPcalls file save failed", error);
          try { await transfer.writable?.abort(); } catch { /* already closed */ }
          setFileTransfers((current) => current.map((item) => item.id === transfer.id ? { ...item, status: "error" } : item));
          notify(`Could not save ${transfer.name}.`);
        } finally {
          incomingFilesRef.current.delete(remoteId);
        }
        return;
      }
    } else if (transfer && event.data instanceof ArrayBuffer) {
      transfer.received += event.data.byteLength;
      if (transfer.writable) await transfer.writable.write(event.data);
      else transfer.chunks.push(event.data);
      setFileTransfers((current) => current.map((item) => item.id === transfer.id ? { ...item, received: transfer.received } : item));
    }
  };

  const getPeerConnection = (remoteId: string) => {
    const existing = pcsRef.current.get(remoteId);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: turnServers });
    pcsRef.current.set(remoteId, pc);
    const local = localStreamRef.current;
    const outgoing = processedVideoStreamRef.current;
    local?.getTracks().forEach((track) => {
      const sendTrack = track.kind === "video" && outgoing ? outgoing.getVideoTracks()[0] : track;
      if (sendTrack) pc.addTrack(sendTrack, sendTrack === track ? local : outgoing!);
    });
    if (peerIdRef.current && peerIdRef.current.localeCompare(remoteId) < 0) {
      const dataChannel = pc.createDataChannel("rpcalls-files", { ordered: true });
      bindDataChannel(remoteId, dataChannel);
    }
    pc.ondatachannel = (event) => bindDataChannel(remoteId, event.channel);
    pc.onicecandidate = (event) => {
      if (event.candidate) void sendSignal({ to: remoteId, kind: "ice", candidate: event.candidate.toJSON() });
    };
    pc.ontrack = (event) => {
      let stream = event.streams[0];
      if (!stream) {
        stream = remoteStreamsRef.current.get(remoteId) || new MediaStream();
        if (!stream.getTracks().some((track) => track.id === event.track.id)) stream.addTrack(event.track);
      }
      remoteStreamsRef.current.set(remoteId, stream);
      setRemoteStreams(Object.fromEntries(remoteStreamsRef.current));
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        if (pc.connectionState === "failed") {
          setConnectionState("Connection needs help");
          setTimeout(() => setConnectionState(channelRef.current ? "Connected" : "Ready"), 4000);
        }
        if (pc.connectionState === "closed") {
          pcsRef.current.delete(remoteId);
          remoteStreamsRef.current.delete(remoteId);
          setRemoteStreams(Object.fromEntries(remoteStreamsRef.current));
        }
      }
    };
    return pc;
  };

  const makeOffer = async (remoteId: string) => {
    if (makingOfferRef.current.has(remoteId)) return;
    const pc = getPeerConnection(remoteId);
    if (pc.signalingState !== "stable") return;
    makingOfferRef.current.add(remoteId);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await sendSignal({ to: remoteId, kind: "offer", sdp: pc.localDescription });
    } catch (error) {
      console.warn("RPcalls offer negotiation failed", error);
    } finally {
      makingOfferRef.current.delete(remoteId);
    }
  };

  const handleSignal = async (payload: any) => {
    const remoteId = String(payload?.from || "");
    if (!remoteId || remoteId === peerIdRef.current || payload?.to !== peerIdRef.current) return;
    try {
      if (payload.kind === "host-mute") {
        if (!hostPeerIdRef.current || remoteId !== hostPeerIdRef.current) return;
        localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = false; });
        setMuted(true);
        await trackPresence({ micOn: false });
        notify("The organizer muted your microphone.");
        return;
      }
      const pc = getPeerConnection(remoteId);
      if (payload.kind === "offer" && payload.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        await applyPendingIce(remoteId, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await sendSignal({ to: remoteId, kind: "answer", sdp: pc.localDescription });
      } else if (payload.kind === "answer" && payload.sdp) {
        if (pc.signalingState === "have-local-offer") {
          await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
          await applyPendingIce(remoteId, pc);
        }
      } else if (payload.kind === "renegotiate-request") {
        if (peerIdRef.current.localeCompare(remoteId) < 0) await makeOffer(remoteId);
      } else if (payload.kind === "ice" && payload.candidate) {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } else {
          const queue = pendingIceRef.current.get(remoteId) || [];
          queue.push(payload.candidate as RTCIceCandidateInit);
          pendingIceRef.current.set(remoteId, queue);
        }
      }
    } catch (error) {
      console.warn("RPcalls signaling message failed", error);
    }
  };

  const cleanupMeeting = async () => {
    const channel = channelRef.current;
    channelRef.current = null;
    if (channel) {
      try { await channel.unsubscribe(); } catch { /* already disconnected */ }
      if (supabase) {
        try { await supabase.removeChannel(channel); } catch { /* already removed */ }
      }
    }
    pcsRef.current.forEach((pc) => pc.close());
    pcsRef.current.clear();
    makingOfferRef.current.clear();
    pendingIceRef.current.clear();
    dataChannelsRef.current.clear();
    incomingFilesRef.current.clear();
    remoteStreamsRef.current.clear();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    screenStreamRef.current = null;
    setLocalStream(null);
    setScreenStream(null);
    setRemoteStreams({});
    if (backgroundProcessorRef.current?.segmenter) { try { void backgroundProcessorRef.current.segmenter.close(); } catch { /* cleanup */ } }
    if (backgroundProcessorRef.current?.stream) backgroundProcessorRef.current.stream.getTracks().forEach((track: MediaStreamTrack) => track.stop());
    if (backgroundProcessorRef.current?.video) { try { backgroundProcessorRef.current.video.pause(); backgroundProcessorRef.current.video.srcObject = null; } catch { /* cleanup */ } }
    backgroundProcessorRef.current = null;
    processedVideoStreamRef.current?.getTracks().forEach((track) => track.stop());
    processedVideoStreamRef.current = null;
    setProcessedVideoStream(null);
    setBackgroundEffect("none");
    setFileTransfers([]);
    setParticipants([]);
    setMessages([]);
    setJoined(false);
    setIsAdmitted(false);
    isAdmittedRef.current = false;
    setPeerId("");
    peerIdRef.current = "";
    identityRef.current = { peerId: "", name: "", isHost: false };
    setMuted(false);
    setCameraOn(true);
    setRaised(false);
    setSharingScreen(false);
    setConnectionState("Ready");
    setBusy(false);
  };

  const requestMeetingMedia = async () => {
    let stream: MediaStream | null = null;
    if (joinMicOn || joinCameraOn) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: joinMicOn, video: joinCameraOn });
      } catch {
        if (joinMicOn && joinCameraOn) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            setMediaWarning("Camera access was unavailable, so you joined with audio only. You can adjust permissions in your browser.");
          } catch {
            setMediaWarning("Microphone/camera permission was not granted. You can still join and try enabling devices from the call controls.");
          }
        } else if (joinMicOn) {
          setMediaWarning("Microphone access was unavailable. You can still join and try enabling it from the call controls.");
        } else {
          setMediaWarning("Camera access was unavailable. You can still join and try enabling it from the call controls.");
        }
      }
    }
    localStreamRef.current = stream;
    setLocalStream(stream);
    const hasAudio = Boolean(joinMicOn && stream?.getAudioTracks().some((track) => track.enabled));
    const hasVideo = Boolean(joinCameraOn && stream?.getVideoTracks().some((track) => track.enabled));
    setMuted(!hasAudio);
    setCameraOn(hasVideo);
    presenceRef.current = { ...presenceRef.current, micOn: hasAudio, cameraOn: hasVideo };
    return stream;
  };

  const joinRoom = async (targetRoomId: string, hostOverride = false, mode: "meeting" | "chat" = roomMode, titleOverride?: string) => {
    if (!targetRoomId || joined || busy) return;
    if (!supabase || !realtimeConfigured) {
      setMediaWarning("RPcalls is missing its Realtime connection settings. Ask the app administrator to configure Supabase.");
      setShowSettings(true);
      return;
    }
    const cleanName = safeName(displayName) || "Guest";
    const thisPeerId = randomId(12);
    const host = hostOverride || Boolean(initialParams.get("host")) || (() => {
      try { return Boolean(sessionStorage.getItem(hostStorageKey(targetRoomId))); } catch { return false; }
    })();
    const admitted = host || mode === "chat";
    const title = safeName(titleOverride || meetingTitle || "RPcalls meeting") || "RPcalls meeting";
    setBusy(true);
    setMediaWarning("");
    setRoomId(targetRoomId);
    setRoomMode(mode);
    setIsHost(host);
    hostPeerIdRef.current = host ? thisPeerId : "";
    setIsAdmitted(admitted);
    isAdmittedRef.current = admitted;
    setJoinDenied(false);
    setMeetingTitle(title);
    setDisplayName(cleanName);
    try { localStorage.setItem("rpcalls:name", cleanName); } catch { /* optional */ }
    const params = new URLSearchParams({ [mode === "chat" ? "chat" : "meeting"]: targetRoomId });
    if (mode === "meeting") params.set("title", title);
    history.replaceState(null, "", "/?" + params.toString());
    peerIdRef.current = thisPeerId;
    identityRef.current = { peerId: thisPeerId, name: cleanName, isHost: host };
    setPeerId(thisPeerId);
    if (mode === "meeting" && admitted) {
      await requestMeetingMedia();
    } else {
      setMediaWarning("");
      localStreamRef.current = null;
      setLocalStream(null);
      setMuted(true);
      setCameraOn(false);
    }
    presenceRef.current = { ...presenceRef.current, admitted };
    const channel = supabase.channel(`rpcalls:meeting:${targetRoomId}`, {
      config: {
        private: false,
        broadcast: { ack: true, self: false },
        presence: { key: thisPeerId },
      },
    });
    channelRef.current = channel;
    channel
      .on("presence", { event: "sync" }, () => refreshParticipants(channel))
      .on("presence", { event: "join" }, () => refreshParticipants(channel))
      .on("presence", { event: "leave" }, () => refreshParticipants(channel))
      .on("broadcast", { event: "recording-state" }, ({ payload }: { payload: { active?: boolean; status?: string } }) => {
        if (payload?.active) {
          setRecordingStatus("recording");
          setNotice("This meeting is being recorded by the host.");
        } else {
          setRecordingStatus("off");
        }
      })
      .on("broadcast", { event: "signal" }, ({ payload }: { payload: any }) => { void handleSignal(payload); })
      .on("broadcast", { event: "guest-admission" }, async ({ payload }: { payload: { to?: string; action?: string } }) => {
        if (!payload || payload.to !== peerIdRef.current) return;
        if (payload.action === "admit") {
          if (mode === "meeting") await requestMeetingMedia();
          setIsAdmitted(true);
          isAdmittedRef.current = true;
          setJoinDenied(false);
          await trackPresence({ admitted: true, micOn: presenceRef.current.micOn, cameraOn: presenceRef.current.cameraOn });
          notify("The host admitted you to the meeting.");
        } else if (payload.action === "deny") {
          setJoinDenied(true);
          void cleanupMeeting();
          history.replaceState(null, "", "/");
          setRoomId(null);
          setRoomMode("meeting");
          setIsHost(false);
          setIsAdmitted(false);
          isAdmittedRef.current = false;
          notify("The host did not admit you.");
        }
      })
      .on("broadcast", { event: "chat-message" }, ({ payload }: { payload: ChatMessage }) => {
        if (!payload?.id || payload.from === peerIdRef.current) return;
        setMessages((current) => [...current.slice(-149), payload]);
        setChatUnread((count) => activePanel === "chat" ? count : count + 1);
      })
      .on("broadcast", { event: "meeting-ended" }, ({ payload }: { payload: { by?: string } }) => {
        if (payload?.by === peerIdRef.current) return;
        void cleanupMeeting();
        history.replaceState(null, "", "/");
        setRoomId(null);
        setRoomMode("meeting");
        setIsHost(false);
        setIsAdmitted(false);
        isAdmittedRef.current = false;
        notify(mode === "chat" ? "The chat room was ended." : "The organizer ended this meeting.");
      })
      .subscribe(async (status: string) => {
        if (status === "SUBSCRIBED") {
          setConnectionState("Connected");
          await channel.track({
            peerId: thisPeerId,
            name: cleanName,
            isHost: host,
            ...presenceRef.current,
            joinedAt: Date.now(),
          });
          setBusy(false);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setConnectionState("Reconnecting");
          setMediaWarning("Realtime connection was interrupted. Check your network and retry if participants do not appear.");
          setBusy(false);
        }
      });
    setJoined(true);
    setActivePanel("chat");
    setMeetingTab("overview");
    setChatUnread(0);
    setBusy(false);
  };

  const createMeeting = () => {
    setNewMeetingTitle("");
    setNewMeetingDate(defaultMeetingDate());
    setNewMeetingTime(defaultMeetingTime());
    setShowCreateMeeting(true);
  };

  const startMeetingNow = async () => {
    const id = randomId(20);
    const title = safeName(newMeetingTitle) || "Untitled meeting";
    const startedAt = Date.now();
    const entry: MeetingEntry = { id, title, startAt: startedAt, createdAt: startedAt, status: "started", mode: "meeting" };
    setCalendarItems((items) => [entry, ...items.filter((item) => item.id !== id)].slice(0, 200));
    setShowCreateMeeting(false);
    setMeetingTitle(title);
    try { sessionStorage.setItem(hostStorageKey(id), randomId(24)); } catch { /* host marker is optional */ }
    setRoomId(id);
    setRoomMode("meeting");
    setIsHost(true);
    setMessages([]);
    setParticipants([]);
    await joinRoom(id, true, "meeting", title);
  };

  const scheduleMeeting = () => {
    const title = safeName(newMeetingTitle) || "Untitled meeting";
    const startAt = new Date(`${newMeetingDate}T${newMeetingTime}`).getTime();
    if (!Number.isFinite(startAt)) { notify("Choose a valid meeting date and time."); return; }
    const id = randomId(20);
    const entry: MeetingEntry = { id, title, startAt, createdAt: Date.now(), status: "scheduled", mode: "meeting" };
    setCalendarItems((items) => [...items, entry].sort((a, b) => a.startAt - b.startAt).slice(-200));
    setCalendarMonth(new Date(new Date(startAt).getFullYear(), new Date(startAt).getMonth(), 1));
    setMeetingTab("meetings");
    setShowCreateMeeting(false);
    notify("Meeting scheduled in this browser's RPcalls calendar.");
  };

  const openScheduledMeeting = async (entry: MeetingEntry) => {
    setMeetingTitle(entry.title);
    setRoomId(entry.id);
    setRoomMode("meeting");
    setIsHost(true);
    try { sessionStorage.setItem(hostStorageKey(entry.id), randomId(24)); } catch { /* host marker is optional */ }
    setCalendarItems((items) => items.map((item) => item.id === entry.id ? { ...item, status: "started" } : item));
    setMessages([]);
    setParticipants([]);
    await joinRoom(entry.id, true, "meeting", entry.title);
  };

  const admitGuest = async (targetPeerId: string) => {
    if (!identityRef.current.isHost || !channelRef.current) return;
    await channelRef.current.send({ type: "broadcast", event: "guest-admission", payload: { to: targetPeerId, action: "admit" } });
    setParticipants((items) => items.map((person) => person.peerId === targetPeerId ? { ...person, admitted: true } : person));
    notify("Guest admitted.");
  };

  const denyGuest = async (targetPeerId: string) => {
    if (!identityRef.current.isHost || !channelRef.current) return;
    await channelRef.current.send({ type: "broadcast", event: "guest-admission", payload: { to: targetPeerId, action: "deny" } });
    notify("Guest removed from the waiting room.");
  };

  const createChat = async () => {
    const id = randomId(20);
    try { sessionStorage.setItem(hostStorageKey(id), randomId(24)); } catch { /* host marker is optional */ }
    setRoomId(id);
    setRoomMode("chat");
    setIsHost(true);
    setMessages([]);
    setParticipants([]);
    await joinRoom(id, true, "chat");
  };


  const recordingApi = async (body: Record<string, unknown>) => {
    const baseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
    const publicKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
    if (!baseUrl || !publicKey) throw new Error("Supabase recording endpoint is not configured.");
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/functions/v1/rpcalls-recording`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: publicKey, Authorization: `Bearer ${publicKey}` },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) throw new Error(data.error || "Recording storage request failed.");
    return data as { success: boolean; uploadUrl?: string; objectPath?: string };
  };

  const beginHostRecording = async (targetRoomId: string, title: string) => {
    if (!isHost || roomMode !== "meeting" || recordingStartedRoomRef.current === targetRoomId) return;
    recordingStartedRoomRef.current = targetRoomId;
    if (!("MediaRecorder" in window) || !HTMLCanvasElement.prototype.captureStream) {
      setRecordingStatus("error");
      setRecordingError("This browser cannot record the meeting. Please use a recent version of Chrome or Edge.");
      return;
    }
    const hostToken = (() => { try { return sessionStorage.getItem(hostStorageKey(targetRoomId)) || ""; } catch { return ""; } })();
    if (!hostToken) {
      setRecordingStatus("error");
      setRecordingError("The host recording key is missing. Reopen this meeting from the host browser.");
      return;
    }
    setRecordingStatus("starting");
    setRecordingError("");
    let audioContext: AudioContext | null = null;
    let animationFrame = 0;
    let canvasStream: MediaStream | null = null;
    let recordingStream: MediaStream | null = null;
    const chunks: Blob[] = [];
    const videos = new Map<string, HTMLVideoElement>();
    const audioSources = new Map<string, { stream: MediaStream; source: MediaStreamAudioSourceNode }>();
    let recorder: MediaRecorder | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let canvasContext: CanvasRenderingContext2D | null = null;
    let audioDestination: MediaStreamAudioDestinationNode | null = null;
    let stopped = false;

    const release = () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(animationFrame);
      videos.forEach(video => { video.pause(); video.srcObject = null; });
      videos.clear();
      audioSources.forEach(item => { try { item.source.disconnect(); } catch { /* already disconnected */ } });
      audioSources.clear();
      canvasStream?.getTracks().forEach(track => track.stop());
      recordingStream?.getTracks().forEach(track => track.stop());
      if (audioContext && audioContext.state !== "closed") void audioContext.close();
      mediaRecorderRef.current = null;
      stopRecordingRef.current = null;
    };

    try {
      await recordingApi({ action: "start", meetingId: targetRoomId, title, hostToken, startedAt: new Date().toISOString() });
      audioContext = new AudioContext();
      await audioContext.resume();
      audioDestination = audioContext.createMediaStreamDestination();
      canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      canvasContext = canvas.getContext("2d");
      if (!canvasContext) throw new Error("Could not initialize the meeting recording canvas.");
      canvasStream = canvas.captureStream(20);
      recordingStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...audioDestination.stream.getAudioTracks(),
      ]);

      const ensureStream = (id: string, stream: MediaStream | null) => {
        if (!stream) return;
        const existing = audioSources.get(id);
        if (existing?.stream === stream) return;
        if (existing) { try { existing.source.disconnect(); } catch { /* already disconnected */ } }
        if (stream.getAudioTracks().length) {
          const source = audioContext!.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
          source.connect(audioDestination!);
          audioSources.set(id, { stream, source });
        }
        if (stream.getVideoTracks().length) {
          let video = videos.get(id);
          if (!video) {
            video = document.createElement("video");
            video.autoplay = true;
            video.muted = true;
            video.playsInline = true;
            videos.set(id, video);
          }
          if (video.srcObject !== stream) {
            video.srcObject = stream;
            void video.play().catch(() => undefined);
          }
        }
      };

      const drawFrame = () => {
        if (!canvasContext || !canvas) return;
        ensureStream("host", localStreamRef.current);
        remoteStreamsRef.current.forEach((stream, id) => ensureStream(id, stream));
        const tiles = Array.from(videos.entries()).filter(([, video]) => video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0);
        canvasContext.fillStyle = "#111827";
        canvasContext.fillRect(0, 0, canvas.width, canvas.height);
        canvasContext.fillStyle = "#f9fafb";
        canvasContext.font = "600 26px sans-serif";
        canvasContext.fillText(title.slice(0, 70), 32, 42);
        if (!tiles.length) {
          canvasContext.font = "28px sans-serif";
          canvasContext.fillText("RPcalls meeting recording", 32, 100);
        } else {
          const cols = tiles.length === 1 ? 1 : 2;
          const rows = Math.ceil(tiles.length / cols);
          const top = 68;
          const gap = 12;
          const tileW = (canvas.width - gap * (cols + 1)) / cols;
          const tileH = (canvas.height - top - gap * (rows + 1)) / rows;
          tiles.forEach(([id, video], index) => {
            const x = gap + (index % cols) * (tileW + gap);
            const y = top + Math.floor(index / cols) * (tileH + gap);
            const scale = Math.max(tileW / video.videoWidth, tileH / video.videoHeight);
            const sw = tileW / scale, sh = tileH / scale;
            const sx = (video.videoWidth - sw) / 2, sy = (video.videoHeight - sh) / 2;
            canvasContext!.save();
            canvasContext!.beginPath();
            canvasContext!.roundRect(x, y, tileW, tileH, 14);
            canvasContext!.clip();
            canvasContext!.drawImage(video, sx, sy, sw, sh, x, y, tileW, tileH);
            canvasContext!.restore();
            canvasContext!.fillStyle = "rgba(0,0,0,.62)";
            canvasContext!.fillRect(x + 10, y + tileH - 38, Math.min(tileW - 20, 240), 28);
            canvasContext!.fillStyle = "#ffffff";
            canvasContext!.font = "16px sans-serif";
            canvasContext!.fillText(id === "host" ? (displayName || "Host") : (participants.find(person => person.peerId === id)?.name || "Participant"), x + 20, y + tileH - 19);
          });
        }
        animationFrame = requestAnimationFrame(drawFrame);
      };
      drawFrame();
      const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find(type => MediaRecorder.isTypeSupported(type));
      recorder = new MediaRecorder(recordingStream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 900_000, audioBitsPerSecond: 96_000 });
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => {
        setRecordingStatus("error");
        setRecordingError("The browser encountered an error while recording this meeting.");
      };
      recorder.onstop = async () => {
        try {
          setRecordingStatus("uploading");
          const blob = new Blob(chunks, { type: recorder?.mimeType || "video/webm" });
          if (!blob.size) throw new Error("The recording was empty.");
          if (blob.size > 4 * 1024 * 1024 * 1024) throw new Error("This recording exceeds the 4 GB upload limit. Shorten the meeting or lower recording quality.");
          const fileName = `${safeFileName(title)}-${targetRoomId}.webm`;
          const signed = await recordingApi({
            action: "upload-url", meetingId: targetRoomId, hostToken, fileName,
            size: blob.size, contentType: blob.type || "video/webm", endedAt: new Date().toISOString(),
          });
          if (!signed.uploadUrl || !signed.objectPath) throw new Error("The storage service did not return an upload link.");
          const uploadResponse = await fetch(signed.uploadUrl, { method: "PUT", headers: { "Content-Type": blob.type || "video/webm" }, body: blob });
          if (!uploadResponse.ok) throw new Error(`Backblaze upload failed (HTTP ${uploadResponse.status}).`);
          await recordingApi({ action: "complete", meetingId: targetRoomId, hostToken, objectPath: signed.objectPath, size: blob.size, contentType: blob.type || "video/webm", endedAt: new Date().toISOString() });
          setRecordingStatus("saved");
          setNotice("Meeting recording saved securely to Backblaze B2.");
          if (channelRef.current) {
            try { await channelRef.current.send({ type: "broadcast", event: "recording-state", payload: { active: false, status: "saved" } }); } catch { /* status indicator only */ }
          }
        } catch (error) {
          setRecordingStatus("error");
          setRecordingError(error instanceof Error ? error.message : "Could not save the meeting recording.");
        } finally {
          release();
        }
      };
      recorder.start(10_000);
      mediaRecorderRef.current = recorder;
      recordingStartedRoomRef.current = targetRoomId;
      stopRecordingRef.current = async () => {
        if (recorder && recorder.state !== "inactive") {
          await new Promise<void>(resolve => {
            const original = recorder!.onstop;
            recorder!.onstop = async event => { try { if (typeof original === "function") await original.call(recorder!, event); } finally { resolve(); } };
            recorder!.stop();
          });
        }
      };
      setRecordingStatus("recording");
      setNotice("Recording started automatically. Everyone in the meeting can see the recording indicator.");
      if (channelRef.current) {
        try { await channelRef.current.send({ type: "broadcast", event: "recording-state", payload: { active: true, status: "recording" } }); } catch { /* indicator only */ }
      }
    } catch (error) {
      release();
      setRecordingStatus("error");
      setRecordingError(error instanceof Error ? error.message : "Could not start meeting recording.");
    }
  };

  const leaveMeeting = async (endForEveryone = false) => {
    const leavingRoomId = roomId;
    const endingAsHost = Boolean(endForEveryone && isHost);
    const channel = channelRef.current;
    if (endForEveryone && channel && isHost) {
      try {
        await channel.send({ type: "broadcast", event: "meeting-ended", payload: { by: peerIdRef.current } });
      } catch { /* participant cleanup continues */ }
    }
    if (isHost && stopRecordingRef.current) {
      try { await stopRecordingRef.current(); } catch { /* upload status is shown in the recording indicator */ }
    }
    await cleanupMeeting();
    if (endingAsHost && leavingRoomId) {
      setCalendarItems((items) => items.map((item) => item.id === leavingRoomId ? { ...item, status: "ended" } : item));
    }
    history.replaceState(null, "", "/");
    setRoomId(null);
    setRoomMode("meeting");
    setIsHost(false);
    setIsAdmitted(false);
    isAdmittedRef.current = false;
    setShowInvite(false);
    setNotice(endForEveryone ? "Meeting ended." : "You left the meeting.");
  };

  const toggleMicrophone = async () => {
    const tracks = localStreamRef.current?.getAudioTracks() || [];
    if (!tracks.length) {
      try {
        const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const track = audioOnly.getAudioTracks()[0];
        if (!localStreamRef.current) localStreamRef.current = new MediaStream();
        localStreamRef.current.addTrack(track);
        setLocalStream(localStreamRef.current);
        pcsRef.current.forEach((pc, remoteId) => {
          pc.addTrack(track, localStreamRef.current!);
          if (peerIdRef.current.localeCompare(remoteId) < 0) void makeOffer(remoteId);
          else void sendSignal({ to: remoteId, kind: "renegotiate-request" });
        });
        setMuted(false);
        await trackPresence({ micOn: true });
      } catch {
        setMediaWarning("Microphone access is blocked. Allow microphone access in the browser’s address bar and try again.");
      }
      return;
    }
    const next = !tracks.every((track) => track.enabled);
    tracks.forEach((track) => { track.enabled = next; });
    setMuted(!next);
    await trackPresence({ micOn: next });
  };

  const toggleCamera = async () => {
    const tracks = localStreamRef.current?.getVideoTracks() || [];
    if (!tracks.length) {
      try {
        const videoOnly = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
        const track = videoOnly.getVideoTracks()[0];
        if (!localStreamRef.current) localStreamRef.current = new MediaStream();
        localStreamRef.current.addTrack(track);
        setLocalStream(localStreamRef.current);
        pcsRef.current.forEach((pc, remoteId) => {
          pc.addTrack(track, localStreamRef.current!);
          if (peerIdRef.current.localeCompare(remoteId) < 0) void makeOffer(remoteId);
        });
        setCameraOn(true);
        await trackPresence({ cameraOn: true });
      } catch {
        setMediaWarning("Camera access is blocked. Allow camera access in the browser’s address bar and try again.");
      }
      return;
    }
    const next = !tracks.every((track) => track.enabled);
    tracks.forEach((track) => { track.enabled = next; });
    setCameraOn(next);
    await trackPresence({ cameraOn: next });
  };

  const setBackground = async (effect: BackgroundEffect) => {
    if (backgroundBusy) return;
    setBackgroundBusy(true);
    try {
      const old = backgroundProcessorRef.current;
      if (old) {
        old.stopped = true;
        if (old.frame) cancelAnimationFrame(old.frame);
        try { await old.segmenter?.close(); } catch { /* dispose old segmenter */ }
        try { old.video?.pause(); old.video.srcObject = null; } catch { /* disposed */ }
        old.stream?.getTracks().forEach((track: MediaStreamTrack) => track.stop());
        backgroundProcessorRef.current = null;
      }
      if (effect === "none") {
        processedVideoStreamRef.current?.getTracks().forEach((track) => track.stop());
        processedVideoStreamRef.current = null;
        setProcessedVideoStream(null);
        setBackgroundEffect("none");
        const rawTrack = localStreamRef.current?.getVideoTracks()[0] || null;
        pcsRef.current.forEach((pc) => {
          const sender = pc.getSenders().find((item) => item.track?.kind === "video");
          if (sender) void sender.replaceTrack(rawTrack);
        });
        notify("Background effects turned off.");
        return;
      }
      let rawTrack = localStreamRef.current?.getVideoTracks()[0] || null;
      if (!rawTrack) {
        const cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        rawTrack = cameraStream.getVideoTracks()[0];
        if (!localStreamRef.current) localStreamRef.current = new MediaStream();
        localStreamRef.current.addTrack(rawTrack);
        setLocalStream(localStreamRef.current);
        setCameraOn(true);
        await trackPresence({ cameraOn: true });
        pcsRef.current.forEach((pc, remoteId) => {
          if (!pc.getSenders().some((item) => item.track?.kind === "video")) {
            pc.addTrack(rawTrack!, localStreamRef.current!);
            if (peerIdRef.current.localeCompare(remoteId) < 0) void makeOffer(remoteId);
            else void sendSignal({ to: remoteId, kind: "renegotiate-request" });
          }
        });
      }
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = new MediaStream([rawTrack!]);
      await video.play();
      const width = Math.max(320, Math.min(1280, rawTrack!.getSettings().width || 640));
      const height = Math.max(180, Math.min(720, rawTrack!.getSettings().height || 360));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      const foreground = document.createElement("canvas");
      foreground.width = width;
      foreground.height = height;
      const fgCtx = foreground.getContext("2d");
      if (!ctx || !fgCtx || !canvas.captureStream) throw new Error("Canvas background effects are not supported in this browser.");
      const globals = window as any;
      if (!globals.SelfieSegmentation) {
        await new Promise<void>((resolve, reject) => {
          const existing = document.querySelector('script[data-rpcalls-segmentation="true"]') as HTMLScriptElement | null;
          if (existing) {
            existing.addEventListener("load", () => resolve(), { once: true });
            existing.addEventListener("error", () => reject(new Error("Could not load the background effect model.")), { once: true });
            window.setTimeout(() => globals.SelfieSegmentation ? resolve() : reject(new Error("Background effect model timed out.")), 12000);
            return;
          }
          const script = document.createElement("script");
          script.src = "https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js";
          script.crossOrigin = "anonymous";
          script.dataset.rpcallsSegmentation = "true";
          script.onload = () => resolve();
          script.onerror = () => reject(new Error("Could not load the background effect model. Check your network and try again."));
          document.head.appendChild(script);
        });
      }
      const segmenter = new globals.SelfieSegmentation({
        locateFile: (file: string) => "https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/" + file,
      });
      await segmenter.setOptions({ modelSelection: 1 });
      const outputStream = canvas.captureStream(24);
      const processor: any = { video, canvas, segmenter, stream: outputStream, stopped: false, frame: 0 };
      backgroundProcessorRef.current = processor;
      segmenter.onResults((results: any) => {
        if (processor.stopped) return;
        ctx.save();
        ctx.clearRect(0, 0, width, height);
        if (effect === "blur") {
          ctx.filter = "blur(14px)";
          ctx.drawImage(results.image, -12, -12, width + 24, height + 24);
          ctx.filter = "none";
        } else {
          const gradient = ctx.createLinearGradient(0, 0, width, height);
          if (effect === "studio") {
            gradient.addColorStop(0, "#26364f");
            gradient.addColorStop(0.55, "#445e78");
            gradient.addColorStop(1, "#91a9bb");
          } else {
            gradient.addColorStop(0, "#f3ded0");
            gradient.addColorStop(0.55, "#e5d8cf");
            gradient.addColorStop(1, "#bdc6d8");
          }
          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, width, height);
        }
        fgCtx.save();
        fgCtx.clearRect(0, 0, width, height);
        fgCtx.drawImage(results.image, 0, 0, width, height);
        fgCtx.globalCompositeOperation = "destination-in";
        fgCtx.drawImage(results.segmentationMask, 0, 0, width, height);
        fgCtx.globalCompositeOperation = "source-over";
        fgCtx.restore();
        ctx.drawImage(foreground, 0, 0, width, height);
        ctx.restore();
      });
      processedVideoStreamRef.current = outputStream;
      setProcessedVideoStream(outputStream);
      setBackgroundEffect(effect);
      const processedTrack = outputStream.getVideoTracks()[0];
      pcsRef.current.forEach((pc, remoteId) => {
        const sender = pc.getSenders().find((item) => item.track?.kind === "video");
        if (sender) void sender.replaceTrack(processedTrack);
        else {
          pc.addTrack(processedTrack, outputStream);
          if (peerIdRef.current.localeCompare(remoteId) < 0) void makeOffer(remoteId);
          else void sendSignal({ to: remoteId, kind: "renegotiate-request" });
        }
      });
      const processFrame = async () => {
        if (processor.stopped) return;
        try { if (video.readyState >= 2) await segmenter.send({ image: video }); }
        catch (error) { console.debug("Background segmentation frame skipped", error); }
        if (!processor.stopped) processor.frame = requestAnimationFrame(() => { void processFrame(); });
      };
      void processFrame();
      notify(effect === "blur" ? "Background blur enabled." : "Virtual background enabled.");
    } catch (error: any) {
      setBackgroundEffect("none");
      setProcessedVideoStream(null);
      processedVideoStreamRef.current?.getTracks().forEach((track) => track.stop());
      processedVideoStreamRef.current = null;
      notify(error?.message || "Could not apply the background effect.");
    } finally {
      setBackgroundBusy(false);
    }
  };

  const toggleScreenShare = async () => {
    if (sharingScreen) {
      screenStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenStreamRef.current = null;
      setScreenStream(null);
      setSharingScreen(false);
      const cameraTrack = localStreamRef.current?.getVideoTracks()[0] || null;
      pcsRef.current.forEach((pc) => {
        const sender = pc.getSenders().find((item) => item.track?.kind === "video");
        if (sender) void sender.replaceTrack(cameraTrack);
      });
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setMediaWarning("Screen sharing is not supported by this browser.");
      return;
    }
    try {
      const share = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = share.getVideoTracks()[0];
      screenStreamRef.current = share;
      setScreenStream(share);
      setSharingScreen(true);
      pcsRef.current.forEach((pc) => {
        const sender = pc.getSenders().find((item) => item.track?.kind === "video");
        if (sender) void sender.replaceTrack(track);
        else if (localStreamRef.current) {
          pc.addTrack(track, share);
          const remoteId = Array.from(pcsRef.current.entries()).find(([, value]) => value === pc)?.[0];
          if (remoteId) {
            if (peerIdRef.current.localeCompare(remoteId) < 0) void makeOffer(remoteId);
            else void sendSignal({ to: remoteId, kind: "renegotiate-request" });
          }
        }
      });
      track.onended = () => {
        screenStreamRef.current?.getTracks().forEach((item) => item.stop());
        screenStreamRef.current = null;
        setScreenStream(null);
        setSharingScreen(false);
        const cameraTrack = localStreamRef.current?.getVideoTracks()[0] || null;
        pcsRef.current.forEach((pc) => {
          const sender = pc.getSenders().find((item) => item.track?.kind === "video");
          if (sender) void sender.replaceTrack(cameraTrack);
        });
      };
    } catch (error: any) {
      if (error?.name !== "NotAllowedError") setMediaWarning(error?.message || "Could not start screen sharing.");
    }
  };

  const chooseAutoSaveFolder = async () => {
    const picker = (window as any).showDirectoryPicker;
    if (!picker) {
      notify("Automatic folder saving requires a browser with File System Access support, such as desktop Edge or Chrome. Files will still download normally.");
      return;
    }
    try {
      const directory = await picker({ mode: "readwrite" });
      saveDirectoryHandleRef.current = directory;
      setAutoSaveFolderName(directory.name || "Selected folder");
      notify("Auto-save folder selected. Incoming files will be written directly to that folder.");
    } catch (error: any) {
      if (error?.name !== "AbortError") notify(error?.message || "Could not access the selected folder.");
    }
  };

  const sendFileToRoom = async (file: File) => {
    const activePeerIds = identityRef.current.isHost
      ? participants.filter((person) => person.peerId !== peerIdRef.current && person.admitted !== false).map((person) => person.peerId)
      : hostPeerIdRef.current && hostPeerIdRef.current !== peerIdRef.current ? [hostPeerIdRef.current] : [];
    if (!activePeerIds.length) {
      notify(identityRef.current.isHost ? "No admitted guests are available to receive this file." : "Wait for the host to admit you before sharing files.");
      return;
    }
    if (file.size > 500 * 1024 * 1024) {
      notify("Files are limited to 500 MB in this first version.");
      return;
    }
    const targets = activePeerIds.map((id) => ({ id, channel: dataChannelsRef.current.get(id) }))
      .filter((item) => item.channel?.readyState === "open");
    if (!targets.length) {
      notify("The direct file channel is not ready yet. Wait a moment and try again.");
      return;
    }
    const id = randomId(12);
    const transferItem: FileTransfer = { id, name: file.name, size: file.size, received: 0, status: "receiving", direction: "sent" };
    setFileTransfers((current) => [transferItem, ...current].slice(0, 8));
    const chunkSize = 48 * 1024;
    try {
      for (const target of targets) {
        const channel = target.channel!;
        channel.send(JSON.stringify({ kind: "file-start", id, name: file.name, size: file.size, type: file.type, fromName: identityRef.current.name }));
        for (let offset = 0; offset < file.size; offset += chunkSize) {
          while (channel.bufferedAmount > 1024 * 1024 && channel.readyState === "open") {
            await new Promise<void>((resolve) => {
              const resume = () => { channel.removeEventListener("bufferedamountlow", resume); resolve(); };
              channel.addEventListener("bufferedamountlow", resume, { once: true });
              window.setTimeout(resume, 500);
            });
          }
          if (channel.readyState !== "open") throw new Error("The direct connection closed while sending the file.");
          channel.send(await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer());
        }
        channel.send(JSON.stringify({ kind: "file-end", id }));
      }
      setFileTransfers((current) => current.map((item) => item.id === id ? { ...item, received: file.size, status: "saved" } : item));
      notify(`Sent ${file.name} directly to ${targets.length === 1 ? "the host" : "meeting participants"}.`);
    } catch (error: any) {
      setFileTransfers((current) => current.map((item) => item.id === id ? { ...item, status: "error" } : item));
      notify(error?.message || "The file could not be sent.");
    }
  };

  const muteParticipant = async (targetPeerId: string) => {
    if (!identityRef.current.isHost || !targetPeerId || targetPeerId === peerIdRef.current) return;
    await sendSignal({ to: targetPeerId, kind: "host-mute" });
    notify("Mute request sent.");
  };

  const sendChat = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    const channel = channelRef.current;
    if (!text || !channel || !peerIdRef.current) return;
    const message: ChatMessage = {
      id: randomId(10),
      from: peerIdRef.current,
      name: identityRef.current.name || "Guest",
      text: text.slice(0, 1800),
      sentAt: Date.now(),
    };
    setDraft("");
    setMessages((current) => [...current.slice(-149), message]);
    try {
      await channel.send({ type: "broadcast", event: "chat-message", payload: message });
    } catch {
      notify("Message may not have reached everyone. Check the connection.");
    }
  };

  const copyInvite = async () => {
    if (!roomId) return;
    const link = currentRoomLink(roomId);
    try {
      await navigator.clipboard.writeText(link);
      setInviteCopied(true);
      notify(roomMode === "chat" ? "Chat link copied — anyone with the link can join." : "Meeting link copied — anyone with the link can join.");
      setTimeout(() => setInviteCopied(false), 2200);
    } catch {
      window.prompt(roomMode === "chat" ? "Copy this chat link and send it to your guest:" : "Copy this meeting link and send it to your guest:", link);
    }
  };

  const shareInvite = async () => {
    if (!roomId) return;
    const url = currentRoomLink(roomId);
    if (navigator.share) {
      try { await navigator.share({ title: roomMode === "chat" ? "Join my RPcalls chat" : "Join my RPcalls meeting", text: roomMode === "chat" ? "Join my chat using this link:" : "Join my meeting using this link:", url }); return; } catch { /* user cancelled or share unavailable */ }
    }
    await copyInvite();
  };

  const raiseHand = async () => {
    const next = !raised;
    setRaised(next);
    await trackPresence({ raised: next });
  };

  const closeJoin = () => {
    history.replaceState(null, "", "/");
    setRoomId(null);
    setRoomMode("meeting");
    setIsHost(false);
    setMeetingTab("overview");
  };

  useEffect(() => {
    if (joined && roomId && roomMode === "meeting" && isHost && isAdmitted && recordingStartedRoomRef.current !== roomId && recordingStatus !== "error") {
      void beginHostRecording(roomId, meetingTitle);
    }
  }, [joined, roomId, roomMode, isHost, isAdmitted, meetingTitle, recordingStatus]);

  const remoteParticipants = participants.filter((person) => person.peerId !== peerId);
  const localPreview = screenStream || localStream;
  const totalParticipants = Math.max(participants.length, joined ? 1 : 0);
  const waitingParticipants = participants.filter((person) => person.peerId !== peerId && person.admitted === false && !person.isHost);
  const calendarCells = useMemo(() => {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const count = new Date(year, month + 1, 0).getDate();
    const total = Math.ceil((firstDay + count) / 7) * 7;
    return Array.from({ length: total }, (_, index) => new Date(year, month, index - firstDay + 1));
  }, [calendarMonth]);
  const calendarItemsByDate = useMemo(() => {
    const grouped: Record<string, MeetingEntry[]> = {};
    calendarItems.forEach((item) => {
      const key = localDateValue(new Date(item.startAt));
      grouped[key] = [...(grouped[key] || []), item];
    });
    return grouped;
  }, [calendarItems]);

  if (!roomId && !joined && authStatus !== "active") {
    return (
      <div className="joinPage authGatePage">
        <div className="bauhausBackdrop" aria-hidden="true"><span className="bauhausOrb orbOne"/><span className="bauhausOrb orbTwo"/><span className="bauhausRing"/><span className="bauhausBlock blockOne"/><span className="bauhausBlock blockTwo"/><span className="bauhausBar"/><span className="bauhausDotField"/></div>
        <header className="joinHeader">
          <a className="brandLink" href="/" onClick={(event) => event.preventDefault()}><span className="brandMark">RP</span><strong>RPcalls</strong></a>
          <span className="joinHeaderSecure"><ShieldCheck size={15}/> Remote Professionals workspace</span>
        </header>
        <main className="authGateGrid">
          <section className="authGateCard">
            <div className="dialogIcon"><ShieldCheck size={23}/></div>
            <p className="eyebrow">WORKSPACE SIGN IN</p>
            {authStatus === "loading" ? (
              <>
                <h1>Checking your account…</h1>
                <p className="joinDescription">Verifying your RPportal login securely.</p>
                <div className="authLoadingBar"><span/></div>
              </>
            ) : (
              <>
                <h1>Sign in to RPcalls.</h1>
                <p className="joinDescription">Use the same email and password you already use for RPportal. No second account is needed.</p>
                <form className="joinForm authGateForm" onSubmit={(event) => void handleRPportalLogin(event)}>
                  <label className="fieldLabel">RPportal email
                    <input type="email" autoComplete="username" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="you@company.com" required/>
                  </label>
                  <label className="fieldLabel">Password
                    <input type="password" autoComplete="current-password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} placeholder="Your RPportal password" required/>
                  </label>
                  {authError && <div className="authGateError" role="alert"><AlertCircle size={16}/><span>{authError}</span></div>}
                  <button className="primaryButton joinSubmit" type="submit" disabled={authBusy || !supabase}>
                    {authBusy ? "Signing in…" : "Sign in with RPportal"} <ArrowLeft className="joinArrow" size={16}/>
                  </button>
                </form>
                <a className="primaryButton joinSubmit" href="https://rpportal-ten.vercel.app/?sso=rpcalls" style={{display:"flex",justifyContent:"center",marginTop:12,textDecoration:"none"}}>
                  Continue with existing RPportal session <ArrowLeft className="joinArrow" size={16}/>
                </a>
                <div className="joinDisclaimer"><ShieldCheck size={15}/><span>Only active users in the RPportal user directory can open the workspace. Guests can still join using a meeting invite link.</span></div>
              </>
            )}
          </section>
          <aside className="joinAside">
            <div className="joinQuote"><ShieldCheck size={18}/><h2>One account. Two apps.</h2><p>Your RPportal credentials are checked against the existing Remote Professionals user directory. RPcalls does not create or store a separate password.</p></div>
            <div className="joinFeature"><span><Users size={17}/></span><div><strong>Guest links still work</strong><small>Invited participants can join without an RPportal account.</small></div></div>
          </aside>
        </main>
        <footer className="joinFooter"><span>© RPcalls · Remote Professionals</span><span>Secured by Supabase Auth</span></footer>
      </div>
    );
  }

  if (joined && roomId && roomMode === "meeting" && !isAdmitted) {
    return (
      <div className="joinPage waitingRoomPage">
        <div className="bauhausBackdrop" aria-hidden="true"><span className="bauhausOrb orbOne"/><span className="bauhausOrb orbTwo"/><span className="bauhausRing"/><span className="bauhausBlock blockOne"/><span className="bauhausBlock blockTwo"/><span className="bauhausBar"/><span className="bauhausDotField"/></div>
        <header className="joinHeader"><a className="brandLink" href="/" onClick={(e)=>{e.preventDefault();void leaveMeeting(false)}}><span className="brandMark">RP</span><strong>RPcalls</strong></a><span className="joinHeaderSecure"><ShieldCheck size={15}/> Guest waiting room</span></header>
        <main className="joinGrid waitingGrid">
          <section className="joinCard waitingCard">
            <div className="dialogIcon waitingPulse"><Clock3 size={24}/></div>
            <p className="eyebrow">WAITING ROOM</p>
            <h1>{meetingTitle}</h1>
            <p className="joinDescription">You’re in the waiting room. The organizer will be notified and must admit you before you can join the meeting.</p>
            <div className="waitingStatus"><span className="liveDot"/><span>Waiting for the host to let you in…</span></div>
            <button className="secondaryButton waitingLeave" type="button" onClick={() => void leaveMeeting(false)}><ArrowLeft size={15}/> Leave waiting room</button>
          </section>
          <aside className="joinAside"><div className="joinQuote"><ShieldCheck size={18}/><h2>Almost there.</h2><p>Keep this tab open. When the organizer admits you, the meeting will open automatically.</p></div><div className="joinFeature"><span><Users size={17}/></span><div><strong>Host-controlled access</strong><small>You’ll enter once the organizer approves.</small></div></div></aside>
        </main>
      </div>
    );
  }

  if (joined && roomId) {
    const allTiles = [
      { id: peerId, name: identityRef.current.name || displayName || "You", stream: localPreview, local: true, cameraOn: sharingScreen || cameraOn, host: isHost },
      ...remoteParticipants.map((person) => ({
        id: person.peerId, name: person.name || "Guest",
        stream: remoteStreams[person.peerId] || null,
        local: false, cameraOn: Boolean(person.cameraOn), host: Boolean(person.isHost),
      })),
    ];
    return (
      <div className="appShell meetingShell">
        <header className="meetingTopbar">
          <div className="brandMark smallMark">RP</div>
          <div className="meetingTitleBlock">
            <strong>{roomMode === "chat" ? "RPcalls chat" : meetingTitle}</strong>
            {roomMode === "meeting" && <small className="meetingIdLabel">ID: {roomId.slice(0, 12).toUpperCase()}</small>}
            <span><span className="liveDot" />{connectionState} <i>·</i> {totalParticipants} participant{totalParticipants === 1 ? "" : "s"}</span>
            {roomMode === "meeting" && recordingStatus === "recording" && <span className="recordingBadge"><span /> RECORDING</span>}
            {roomMode === "meeting" && recordingStatus === "uploading" && <span className="recordingBadge uploadingBadge">SAVING RECORDING…</span>}
          </div>
          <div className="meetingTopActions">
            <button className="outlineButton" type="button" onClick={shareInvite}><UserRoundPlus size={16} /> Invite</button>
            <button className="iconButton" aria-label="Meeting settings" onClick={() => setShowSettings(true)}><Settings2 size={17} /></button>
            <button className="iconButton" aria-label="Close meeting" onClick={() => void leaveMeeting(false)}><X size={18} /></button>
          </div>
        </header>
        <main className={`meetingWorkspace ${activePanel ? "panelOpen" : ""}`}>
          <section className="meetingStage">
            {recordingStatus === "error" && <div className="inlineAlert recordingAlert"><AlertCircle size={16}/><span>Recording could not be saved: {recordingError}</span></div>}
            <div className="stageHeading">
              <div><p className="eyebrow">{roomMode === "chat" ? "LIVE CHAT" : "LIVE MEETING"}</p><h1>{roomMode === "chat" ? "Your conversation is ready." : meetingTitle}</h1><p>{roomMode === "chat" ? "Share this link to bring someone into the conversation." : "Meeting ID: " + roomId.slice(0, 12).toUpperCase() + " · Share your link to invite guests."}</p></div>
              <button className="subtleButton" type="button" onClick={() => setShowInvite(true)}><Link2 size={15} /> Meeting info</button>
            </div>
            {mediaWarning && <div className="inlineAlert"><AlertCircle size={16} /><span>{mediaWarning}</span><button type="button" onClick={() => setMediaWarning("")}><X size={14} /></button></div>}
            <div className={`videoGrid ${allTiles.length===1?"oneTile":allTiles.length===2?"twoTiles":allTiles.length>4?"manyTiles":""}`}>
              {allTiles.map((tile) => <VideoTile key={tile.id || "local"} name={tile.name} stream={tile.stream} muted={tile.local} local={tile.local} cameraOn={tile.cameraOn} isHost={tile.host} />)}
              {allTiles.length === 1 && <button type="button" className="emptyGuestCard" onClick={() => setShowInvite(true)}><span className="emptyGuestIcon"><UserRoundPlus size={24} /></span><strong>You're the first one here</strong><span>{roomMode === "chat" ? "Share this chat link to start messaging with someone." : "Invite someone outside your organization with a link."}</span><b>Invite a guest <Plus size={14}/></b></button>}
            </div>
            <div className="meetingControlDock">
              <div className="dockLeft"><span className="meetingTime"><Wifi size={14}/>{connectionState}</span>
                {recordingStatus === "error" && <span className="recordingErrorHint" title={recordingError || "Recording failed"}><AlertCircle size={14}/> Recording failed</span>}
              </div>
              <div className="callControls">
                <button type="button" className={muted ? "controlButton isOff" : "controlButton"} onClick={() => void toggleMicrophone()} title={muted ? "Turn microphone on" : "Mute microphone"}><span>{muted ? <MicOff size={19}/> : <Mic size={19}/>}</span><small>{muted ? "Unmute" : "Mute"}</small></button>
                <button type="button" className={!cameraOn ? "controlButton isOff" : "controlButton"} onClick={() => void toggleCamera()} title={cameraOn ? "Turn camera off" : "Turn camera on"}><span>{cameraOn ? <Video size={19}/> : <VideoOff size={19}/>}</span><small>Camera</small></button>
                <button type="button" className={sharingScreen ? "controlButton activeControl" : "controlButton"} onClick={() => void toggleScreenShare()} title={sharingScreen ? "Stop sharing" : "Share screen"}><span><MonitorUp size={19}/></span><small>{sharingScreen ? "Stop share" : "Share"}</small></button>
                <button type="button" className={raised ? "controlButton activeControl" : "controlButton"} onClick={() => void raiseHand()} title={raised ? "Lower hand" : "Raise hand"}><span>✋</span><small>{raised ? "Lower hand" : "Raise"}</small></button>
                <button type="button" className={activePanel === "people" ? "controlButton activeControl" : "controlButton"} onClick={() => {setActivePanel("people");setChatUnread(0)}} title="Participants"><span><Users size={19}/></span><small>People <b>{totalParticipants}</b></small></button>
                <button type="button" className={activePanel === "chat" ? "controlButton activeControl" : "controlButton"} onClick={() => {setActivePanel("chat");setChatUnread(0)}} title="Meeting chat"><span><MessageCircle size={19}/>{chatUnread>0&&<i className="unreadDot"/>}</span><small>Chat</small></button>
                <button type="button" className="endCallButton" onClick={() => void leaveMeeting(isHost)} title={isHost ? "End meeting for everyone" : "Leave meeting"}><PhoneOff size={19}/><small>{isHost ? "End" : "Leave"}</small></button>
              </div>
              <div className="dockRight"><button type="button" className="dockIcon" onClick={() => setShowSettings(true)} title="Device and connection settings"><Settings2 size={18}/></button><button type="button" className="dockIcon" onClick={() => setShowInvite(true)} title="Meeting details"><MoreHorizontal size={19}/></button></div>
            </div>
          </section>
          <aside className="meetingSidePanel">
            <div className="sidePanelHeader">
              <div><h2>{activePanel === "chat" ? "Meeting chat" : "People"}</h2><p>{activePanel === "chat" ? "Messages are shared with everyone here." : `${totalParticipants} in this meeting`}</p></div>
              <button className="iconButton" type="button" onClick={() => setActivePanel(activePanel === "chat" ? "people" : "chat")} aria-label="Switch panel"><PanelRight size={17}/></button>
            </div>
            {activePanel === "chat" ? (
              <>
                <div className="chatSearch"><MessageCircle size={15}/><input value={chatSearch} onChange={(e) => setChatSearch(e.target.value)} placeholder="Search messages" aria-label="Search chat"/></div>
                <div className="chatMessages">
                  {!messages.length && <div className="chatEmpty"><span className="chatEmptyIcon"><MessageCircle size={21}/></span><strong>Say hello 👋</strong><p>Start the conversation. Your messages are visible to meeting participants while they are connected.</p></div>}
                  {messages.filter((message) => !chatSearch || (message.text+" "+message.name).toLowerCase().includes(chatSearch.toLowerCase())).map((message) => (
                    <div key={message.id} className={`chatMessage ${message.from === peerId ? "ownMessage" : ""}`}>
                      <div className="chatMessageMeta"><span className="chatAvatar">{message.name.charAt(0).toUpperCase()}</span><strong>{message.from === peerId ? "You" : message.name}</strong><time>{timeLabel(message.sentAt)}</time></div>
                      <div className="chatBubble">{message.text}</div>
                    </div>
                  ))}
                  <div ref={messageEndRef}/>
                </div>
                <form className="chatComposer" onSubmit={sendChat}>
                  <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type a message" rows={2} maxLength={1800} aria-label="Type a chat message" onKeyDown={(e) => {if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();void sendChat(e as any)}}}/>
                  <div className="composerActions"><span>Enter to send · Shift + Enter for a new line</span><div className="composerButtons"><button type="button" className="attachFileButton" onClick={() => fileSendInputRef.current?.click()} title={"Send a file "+(isHost?"to participants":"directly to host")} aria-label="Attach and send file"><Paperclip size={15}/></button><button type="submit" disabled={!draft.trim()} aria-label="Send message"><Send size={16}/></button></div></div>
                  <input ref={fileSendInputRef} type="file" className="hiddenFileInput" onChange={(event)=>{const file=event.target.files?.[0];if(file)void sendFileToRoom(file);event.target.value="";}} />
                </form>
              </>
            ) : (
              <div className="participantList">
                {isHost && waitingParticipants.length > 0 && <section className="waitingGuests"><div className="waitingGuestsHeading"><span><Clock3 size={15}/></span><div><strong>Waiting to join</strong><small>{waitingParticipants.length} guest{waitingParticipants.length===1?"":"s"} need approval</small></div></div>{waitingParticipants.map((person)=><div className="waitingGuestRow" key={person.peerId}><div className="participantAvatar">{person.name?.charAt(0)?.toUpperCase()||"G"}</div><div className="participantInfo"><strong>{person.name||"Guest"}</strong><small>Waiting for admission</small></div><button type="button" className="admitButton" onClick={()=>void admitGuest(person.peerId)} title="Admit guest"><UserCheck size={15}/></button><button type="button" className="denyButton" onClick={()=>void denyGuest(person.peerId)} title="Deny guest"><UserX size={15}/></button></div>)}</section>}
                {participants.filter((person) => person.admitted !== false || person.peerId === peerId).map((person) => <div key={person.peerId} className="participantRow"><div className="participantAvatar">{person.name?.charAt(0)?.toUpperCase()||"G"}{person.raised&&<span>✋</span>}</div><div className="participantInfo"><strong>{person.peerId===peerId?"You":person.name||"Guest"}{person.isHost&&<span className="hostPill">Organizer</span>}</strong><small>{person.peerId===peerId?"Meeting device":person.micOn===false?"Microphone muted":"In the meeting"}</small></div><div className="participantStatus">{person.micOn===false?<MicOff size={15}/>:<Mic size={15}/>} {person.cameraOn===false?<VideoOff size={15}/>:<Video size={15}/>}</div>{isHost&&person.peerId!==peerId&&person.admitted!==false&&<button type="button" className="participantMuteButton" title={"Mute "+person.name} aria-label={"Mute "+person.name} disabled={person.micOn===false} onClick={()=>void muteParticipant(person.peerId)}><MicOff size={14}/></button>}</div>)}
                {!participants.length&&<p className="muted smallText">Connecting to meeting participants…</p>}
                {isHost && <div className="autoSavePanel"><div className="autoSaveCopy"><FolderOpen size={16}/><div><strong>Auto-save received files</strong><small>{autoSaveFolderName ? "Folder: "+autoSaveFolderName : autoSaveSupported ? "Choose a folder to save incoming files automatically." : "This browser supports downloads only."}</small></div></div><button type="button" className="secondaryButton" onClick={()=>void chooseAutoSaveFolder()}><FolderOpen size={14}/>{autoSaveFolderName?"Change folder":"Choose folder"}</button></div>}
                <input ref={fileSendInputRef} type="file" className="hiddenFileInput" onChange={(event)=>{const file=event.target.files?.[0];if(file)void sendFileToRoom(file);event.target.value="";}} />
                <button type="button" className="invitePeopleButton" onClick={() => fileSendInputRef.current?.click()}><Paperclip size={16}/> Send file directly to {isHost?"guests":"host"}</button>
                <div className="fileTransferList">{fileTransfers.slice(0,4).map((file)=><div className="fileTransferRow" key={file.id}><FileUp size={15}/><div><strong>{file.name}</strong><small>{Math.round(file.received/1024)} KB / {Math.ceil(file.size/1024)} KB · {file.status}</small></div><span className={"fileTransferStatus "+file.status}>{file.status==="saved"||file.status==="downloaded"?<Check size={13}/>:file.status==="error"?<AlertCircle size={13}/>:<span className="fileTransferSpinner"/>}</span></div>)}</div>
                <button type="button" className="invitePeopleButton" onClick={() => setShowInvite(true)}><UserRoundPlus size={16}/> Invite someone</button>
              </div>
            )}
          </aside>
        </main>
        {showInvite && <div className="dialogScrim" onMouseDown={(e) => {if(e.target===e.currentTarget)setShowInvite(false)}}><section className="inviteDialog" role="dialog" aria-modal="true" aria-labelledby="inviteTitle"><button className="dialogClose" type="button" onClick={() => setShowInvite(false)} aria-label="Close"><X size={17}/></button><div className="dialogIcon"><Link2 size={22}/></div><p className="eyebrow">MEETING DETAILS</p><h2 id="inviteTitle">Invite anyone to RPcalls</h2><p className="dialogIntro">Send this link to colleagues, clients, or guests outside Remote Professionals. They can join from their browser without an RP account.</p><label className="fieldLabel">{roomMode === "chat" ? "Chat link" : "Meeting link"}<div className="copyLinkField"><input readOnly value={currentRoomLink()} aria-label={roomMode === "chat" ? "Chat link" : "Meeting link"}/><button type="button" onClick={() => void copyInvite()}>{inviteCopied?<Check size={16}/>:<Copy size={16}/>}<span>{inviteCopied?"Copied":"Copy"}</span></button></div></label><div className="guestAccessNote"><ShieldCheck size={17}/><span><strong>Anyone with the link can join.</strong> Treat the invitation as access to this meeting and share it only with intended participants.</span></div><div className="dialogActions"><button type="button" className="secondaryButton" onClick={() => setShowInvite(false)}>Done</button><button type="button" className="primaryButton" onClick={() => void shareInvite()}><Share2 size={16}/> Share invite</button></div></section></div>}
        {showSettings&&<div className="dialogScrim" onMouseDown={(e)=>{if(e.target===e.currentTarget)setShowSettings(false)}}><section className="settingsDialog" role="dialog" aria-modal="true" aria-labelledby="settingsTitle"><button className="dialogClose" type="button" onClick={()=>setShowSettings(false)} aria-label="Close"><X size={17}/></button><div className="dialogIcon"><Settings2 size={22}/></div><p className="eyebrow">DEVICE & CONNECTION</p><h2 id="settingsTitle">Meeting settings</h2><div className="settingsInfo"><div><strong>Realtime connection</strong><span>{realtimeConfigured?"Configured":"Not configured"}</span></div><div><strong>ICE servers</strong><span>{turnServers.length>1?"STUN + TURN":"STUN only"}</span></div><div><strong>Connection status</strong><span>{connectionState}</span></div></div><section className="backgroundSection"><div className="backgroundSectionHeading"><div><strong>Background effects</strong><small>Blur the room or use a soft virtual backdrop.</small></div><span className={backgroundBusy?"backgroundBusy":""}>{backgroundBusy?"Loading…":backgroundEffect==="none"?"Off":backgroundEffect==="blur"?"Blur":backgroundEffect==="studio"?"Studio":"Warm"}</span></div><div className="backgroundOptions"><button type="button" className={backgroundEffect==="none"?"backgroundOption chosen":"backgroundOption"} disabled={backgroundBusy} onClick={()=>void setBackground("none")}><span className="backgroundPreview noBackground"><Camera size={16}/></span><small>None</small></button><button type="button" className={backgroundEffect==="blur"?"backgroundOption chosen":"backgroundOption"} disabled={backgroundBusy} onClick={()=>void setBackground("blur")}><span className="backgroundPreview blurredBackground"><span/></span><small>Blur</small></button><button type="button" className={backgroundEffect==="studio"?"backgroundOption chosen":"backgroundOption"} disabled={backgroundBusy} onClick={()=>void setBackground("studio")}><span className="backgroundPreview studioBackground"><span/></span><small>Studio</small></button><button type="button" className={backgroundEffect==="warm"?"backgroundOption chosen":"backgroundOption"} disabled={backgroundBusy} onClick={()=>void setBackground("warm")}><span className="backgroundPreview warmBackground"><span/></span><small>Warm</small></button></div><small className="backgroundFootnote">The first use downloads the background model from MediaPipe. Effects are processed in your browser and sent as your camera stream.</small></section><button type="button" className="turnHelpToggle" onClick={()=>setTurnHelp(!turnHelp)}><CircleHelp size={16}/> Why use a TURN server? <ChevronDown size={15}/></button>{turnHelp&&<p className="turnHelpText">STUN-only calls work on many networks, but strict corporate firewalls and some mobile networks require TURN relay. Add VITE_TURN_URLS, VITE_TURN_USERNAME, and VITE_TURN_CREDENTIAL to the Vercel environment to enable it.</p>}<div className="dialogActions"><button type="button" className="secondaryButton" onClick={()=>setShowSettings(false)}>Close</button></div></section></div>}
      </div>
    );
  }

  if (roomId) {
    return (
      <div className="joinPage guestJoinPage">
        <div className="bauhausBackdrop" aria-hidden="true"><span className="bauhausOrb orbOne"/><span className="bauhausOrb orbTwo"/><span className="bauhausRing"/><span className="bauhausBlock blockOne"/><span className="bauhausBlock blockTwo"/><span className="bauhausBar"/><span className="bauhausDotField"/></div>
        <header className="joinHeader guestJoinHeader"><a className="brandLink" href="/" onClick={(e)=>{e.preventDefault();closeJoin()}}><span className="brandMark">RP</span><strong>RPcalls</strong></a></header>
        <main className="guestJoinMain">
          <section className="joinCard guestJoinCard">
            <p className="eyebrow">YOU'RE INVITED</p>
            <h1>{roomMode === "chat" ? "Join the conversation." : "Join the meeting."}</h1>
            <p className="joinDescription">{roomMode === "chat" ? "Enter your name to join this conversation." : "Enter your name and choose your microphone and camera before joining."}</p>
            <form onSubmit={(e)=>{e.preventDefault();void joinRoom(roomId,isHost,roomMode)}} className="joinForm guestJoinForm">
              <label className="fieldLabel">Your name<input autoFocus value={displayName} onChange={(e)=>setDisplayName(e.target.value)} placeholder="Your name" maxLength={50} required/></label>
              {roomMode === "meeting" && <div className="guestMediaOptions" aria-label="Microphone and camera options">
                <button type="button" className={joinMicOn ? "guestMediaToggle selected" : "guestMediaToggle"} aria-pressed={joinMicOn} onClick={()=>setJoinMicOn((value)=>!value)}><span className="guestMediaIcon">{joinMicOn ? <Mic size={19}/> : <MicOff size={19}/>}</span><span><strong>Microphone</strong><small>{joinMicOn ? "On when joining" : "Off when joining"}</small></span><span className={joinMicOn ? "guestTogglePill on" : "guestTogglePill"}><i/></span></button>
                <button type="button" className={joinCameraOn ? "guestMediaToggle selected" : "guestMediaToggle"} aria-pressed={joinCameraOn} onClick={()=>setJoinCameraOn((value)=>!value)}><span className="guestMediaIcon">{joinCameraOn ? <Video size={19}/> : <VideoOff size={19}/>}</span><span><strong>Camera</strong><small>{joinCameraOn ? "On when joining" : "Off when joining"}</small></span><span className={joinCameraOn ? "guestTogglePill on" : "guestTogglePill"}><i/></span></button>
              </div>}
              {mediaWarning&&<div className="inlineAlert"><AlertCircle size={16}/><span>{mediaWarning}</span><button type="button" onClick={()=>setMediaWarning("")}><X size={14}/></button></div>}
              {!realtimeConfigured&&<div className="inlineAlert"><AlertCircle size={16}/><span>Meeting service is not configured yet. Please contact the host.</span></div>}
              <button className="primaryButton joinSubmit" type="submit" disabled={busy||!displayName.trim()||!realtimeConfigured}>{busy?"Joining…":roomMode === "chat" ? "Join chat" : "Join meeting"}<ArrowLeft size={16} className="joinArrow"/></button>
            </form>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="appShell homeShell">
      <aside className="appSidebar">
        <a className="brandLink" href="/" onClick={(e)=>e.preventDefault()}><span className="brandMark">RP</span><span className="brandWordmark"><strong>RPcalls</strong><small>Meet anyone</small></span></a>
        <button className="sidebarNewMeeting" type="button" onClick={() => void createMeeting()}><Plus size={17}/> New meeting</button>
        <nav className="primaryNav">
          <button type="button" className={meetingTab==="overview"?"selected":""} onClick={()=>setMeetingTab("overview")}><Sparkles size={18}/> Overview</button>
          <button type="button" className={meetingTab==="meetings"?"selected":""} onClick={()=>setMeetingTab("meetings")}><CalendarDays size={18}/> Calendar</button>
        </nav>
        <div className="sidebarBottom"><div className="sidebarHelpCard"><span><Headphones size={17}/></span><strong>Need help?</strong><small>Check your connection and browser permissions.</small><button type="button" onClick={()=>setShowSettings(true)}>Connection settings <ArrowLeft size={13}/></button></div><div className="profileMini"><div className="profileMiniAvatar">{displayName.trim().charAt(0).toUpperCase()||"G"}</div><div><strong>{safeName(displayName)||"Guest user"}</strong><small>RPcalls guest</small></div><button type="button" aria-label="Profile options" onClick={()=>setShowSettings(true)}><MoreHorizontal size={17}/></button></div></div>
      </aside>
      <main className="homeMain">
        <header className="homeTopbar"><div className="crumb">Workspace <span>/</span> {meetingTab==="overview"?"Overview":"Calendar"}</div><div className="topbarActions"><span className="topbarStatus"><span className="liveDot"/> {authDisplayName || "RPportal user"}</span><button className="authSignOutButton" type="button" onClick={()=>{void supabase?.auth.signOut();setAuthPassword("");setAuthError("");}} title="Sign out of RPcalls">Sign out</button><button className="iconButton" aria-label="Settings" onClick={()=>setShowSettings(true)}><Settings2 size={18}/></button><div className="profileMiniAvatar topAvatar">{(authDisplayName || displayName).trim().charAt(0).toUpperCase()||"R"}</div></div></header>
        <div className="homeContent">
          {meetingTab==="overview" ? <>
            <section className="homeHero">
              <div className="homeHeroCopy"><div className="heroTag"><span/><span>Say hello to easier conversations</span></div><h1>Meet with anyone.<br/><em>From anywhere.</em></h1><p>One simple link to talk, share your screen, and chat with your team — or a guest outside your organization.</p><div className="heroActions"><button type="button" className="primaryButton" onClick={()=>void createMeeting()}><Video size={18}/> Start a new meeting</button><button type="button" className="secondaryButton" onClick={()=>{const input=document.getElementById("join-link-input") as HTMLInputElement|null;input?.focus()}}><Link2 size={17}/> Join with a link</button></div><div className="heroTrust"><ShieldCheck size={14}/> No org account required for guests <span>·</span> Works in your browser</div></div>
              <div className="heroVisual" aria-hidden="true"><div className="visualBackdrop backdropOne"/><div className="visualBackdrop backdropTwo"/><div className="visualWindow"><div className="visualWindowTop"><span/><span/><span/><b>RPcalls</b><MoreHorizontal size={16}/></div><div className="visualPeople"><div className="visualPerson personA"><b>J</b><span/><small>Jordan Lee</small></div><div className="visualPerson personB"><b>M</b><span/><small>Maya Chen</small></div><div className="visualPerson personC"><b>R</b><span/><small>Riley Park</small></div><div className="visualPerson personD"><b>Y</b><span/><small>You</small></div></div><div className="visualControls"><i/><i/><i/><b><PhoneOff size={14}/></b></div></div><div className="floatChip chipInvite"><UserRoundPlus size={15}/><span>Guest joined</span><Check size={14}/></div><div className="floatChip chipShare"><MonitorUp size={15}/><span>Screen sharing</span></div></div>
            </section>
            <section className="quickActions"><div className="sectionHeading"><div><p className="eyebrow">GET STARTED</p><h2>Ready when you are</h2></div><span>Simple tools for better conversations</span></div><div className="quickActionGrid"><button type="button" className="quickActionCard" onClick={()=>void createMeeting()}><span className="quickIcon purple"><Video size={20}/></span><strong>Start a meeting</strong><small>Open a room and invite anyone with a link.</small><i><ArrowLeft size={16}/></i></button><button type="button" className="quickActionCard" onClick={()=>{const input=document.getElementById("join-link-input") as HTMLInputElement|null;input?.focus()}}><span className="quickIcon blue"><Link2 size={20}/></span><strong>Join a meeting</strong><small>Paste a meeting URL shared with you.</small><i><ArrowLeft size={16}/></i></button><button type="button" className="quickActionCard" onClick={()=>setShowSettings(true)}><span className="quickIcon orange"><Settings2 size={20}/></span><strong>Check your setup</strong><small>Review camera, microphone, and network readiness.</small><i><ArrowLeft size={16}/></i></button></div></section>
            <section className="joinByLinkCard"><div className="joinByIcon"><Link2 size={19}/></div><div className="joinByCopy"><strong>Have a meeting or chat link?</strong><span>Paste it here to join an RPcalls room.</span></div><form onSubmit={(e)=>{e.preventDefault();const input=document.getElementById("join-link-input") as HTMLInputElement|null;if(!input)return;try{const value=new URL(input.value.trim());const mode=value.searchParams.has("chat")?"chat":"meeting";const id=value.searchParams.get("meeting")||value.searchParams.get("chat")||value.pathname.split("/").filter(Boolean).pop();if(!id)throw new Error("No room ID found");setRoomId(id);setRoomMode(mode);setMeetingTitle(value.searchParams.get("title")||"RPcalls meeting");setIsHost(false);history.replaceState(null,"",`/?${mode==="chat"?"chat":"meeting"}=${encodeURIComponent(id)}${mode==="meeting"&&value.searchParams.get("title")?"&title="+encodeURIComponent(value.searchParams.get("title")!):""}`);}catch{notify("That does not look like a valid RPcalls meeting or chat link.");}}}><input id="join-link-input" placeholder="Paste an RPcalls meeting or chat link" type="url" aria-label="Meeting or chat link" required/><button className="secondaryButton" type="submit">Join</button></form></section>
          </> : meetingTab==="meetings" ? <section className="meetingsPage calendarPage">
              <div className="meetingsPageHeading"><div><p className="eyebrow">PLAN AHEAD</p><h1>Calendar</h1><p>Schedule titled meetings, create reusable invite links, and keep the calendar ready for future email integration.</p></div><button type="button" className="primaryButton" onClick={()=>void createMeeting()}><Plus size={17}/> New meeting</button></div>
              <div className="calendarContent">
                <section className="calendarCard">
                  <div className="calendarMonthHeader"><div><h2>{calendarMonth.toLocaleDateString(undefined,{month:"long",year:"numeric"})}</h2><small>{calendarItems.filter((item)=>item.status!=="ended").length} active or upcoming meetings</small></div><div className="calendarMonthControls"><button type="button" aria-label="Previous month" onClick={()=>setCalendarMonth(new Date(calendarMonth.getFullYear(),calendarMonth.getMonth()-1,1))}><ChevronLeft size={17}/></button><button type="button" aria-label="Next month" onClick={()=>setCalendarMonth(new Date(calendarMonth.getFullYear(),calendarMonth.getMonth()+1,1))}><ChevronRight size={17}/></button><button type="button" onClick={()=>setCalendarMonth(new Date(new Date().getFullYear(),new Date().getMonth(),1))}>Today</button></div></div>
                  <div className="calendarGrid">{["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((day)=><span className="calendarWeekday" key={day}>{day}</span>)}{calendarCells.map((day)=>{const key=localDateValue(day);const entries=calendarItemsByDate[key]||[];const inMonth=day.getMonth()===calendarMonth.getMonth();const today=key===localDateValue(new Date());return <button type="button" key={key} className={"calendarDay "+(!inMonth?"outsideMonth ":"")+(today?"isToday ":"")+(entries.length?"hasCalendarEvent":"")} onClick={()=>{setNewMeetingDate(key);setNewMeetingTitle("");setNewMeetingTime(defaultMeetingTime());setShowCreateMeeting(true);}} title={entries.length?entries.length+" meeting(s)":"Schedule a meeting for "+key}><span className="calendarDayNumber">{day.getDate()}</span>{entries.length>0&&<span className="calendarEventDots">{entries.slice(0,3).map((entry)=><i key={entry.id} className={entry.status==="ended"?"endedEventDot":""}/>)}</span>}</button>})}</div>
                  <div className="calendarLegend"><span><i className="calendarLegendLive"/> Started / upcoming</span><span><i className="calendarLegendEnded"/> Ended</span><span>Click a date to schedule</span></div>
                </section>
                <section className="calendarMeetingsCard"><div className="calendarMeetingsHeader"><div><h2>Scheduled meetings</h2><small>Each meeting has its own ID and share link.</small></div><span className="calendarCount">{calendarItems.length}</span></div>
                  {!calendarItems.length?<div className="calendarNoEvents"><span><CalendarDays size={23}/></span><strong>No meetings yet</strong><p>Create a meeting now or schedule one for a future date.</p><button type="button" className="primaryButton" onClick={()=>void createMeeting()}><Plus size={15}/> Create meeting</button></div>:<div className="calendarMeetingList">{[...calendarItems].sort((a,b)=>a.startAt-b.startAt).map((entry)=> <article className="calendarMeetingRow" key={entry.id}><div className="meetingDateBadge"><strong>{new Date(entry.startAt).toLocaleDateString(undefined,{day:"2-digit"})}</strong><span>{new Date(entry.startAt).toLocaleDateString(undefined,{month:"short"})}</span></div><div className="calendarMeetingInfo"><strong>{entry.title}</strong><small><Clock3 size={12}/>{new Date(entry.startAt).toLocaleString(undefined,{weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}</small><small className="calendarMeetingId">ID {entry.id.slice(0,12).toUpperCase()}</small><span className={"calendarStatus "+entry.status}>{entry.status==="scheduled"?"Scheduled":entry.status==="started"?"Created / ready":"Ended"}</span></div><div className="calendarMeetingActions"><button type="button" className="calendarLinkButton" aria-label={"Copy link for "+entry.title} title="Copy invite link" onClick={async()=>{const link=currentRoomLink(entry.id,"meeting",entry.title);try{await navigator.clipboard.writeText(link);notify("Meeting invite link copied.");}catch{window.prompt("Copy meeting invite link:",link);}}}><Copy size={15}/></button>{entry.status!=="ended"&&<button type="button" className="calendarJoinButton" onClick={()=>void openScheduledMeeting(entry)}>{entry.status==="started"?"Open":"Join"}</button>}</div></article>)}</div>}
                </section>
              </div>
              <div className="meetingPolicyNote"><CalendarClock size={17}/><span>This calendar is saved in this browser for now. Meeting titles, dates, IDs, and invite links are prepared for later email/calendar integration, but they do not sync across devices yet.</span></div>
            </section> : <section className="meetingsPage"><div className="meetingsPageHeading"><div><p className="eyebrow">YOUR SPACE</p><h1>Chats</h1><p>Start a shareable chat room, or join a chat link someone has sent you.</p></div><button type="button" className="primaryButton" onClick={()=>void createChat()}><Plus size={17}/> New chat</button></div><div className="meetingEmptyState"><span><MessageCircle size={25}/></span><h2>Start a conversation.</h2><p>Create a chat room and invite coworkers, clients, or people outside your organization. Guests can join from their browser using just their name.</p><button type="button" className="primaryButton" onClick={()=>void createChat()}><MessageCircle size={17}/> Create a chat room</button></div><div className="meetingPolicyNote"><ShieldCheck size={17}/><span>Chat rooms are not publicly listed. Anyone with the invitation link can join; messages are available while participants are connected.</span></div></section>}
        </div>
        <footer className="homeFooter"><span>© RPcalls · Built for thoughtful conversations</span><div><button type="button" onClick={()=>setShowSettings(true)}>Connection help</button><span>·</span><span>Guest-friendly meetings</span></div></footer>
      </main>
      {notice&&<div className="toastNotice" role="status"><CheckCheck size={17}/>{notice}</div>}
      {showCreateMeeting && <div className="dialogScrim" onMouseDown={(e)=>{if(e.target===e.currentTarget)setShowCreateMeeting(false)}}><section className="inviteDialog createMeetingDialog" role="dialog" aria-modal="true" aria-labelledby="createMeetingTitle"><button className="dialogClose" type="button" onClick={()=>setShowCreateMeeting(false)} aria-label="Close"><X size={17}/></button><div className="dialogIcon"><CalendarDays size={22}/></div><p className="eyebrow">NEW MEETING</p><h2 id="createMeetingTitle">Give your meeting a name.</h2><p className="dialogIntro">Every meeting gets its own unique ID and shareable link. Schedule it in your RPcalls calendar, or start immediately.</p><div className="createMeetingFields"><label className="fieldLabel">Meeting title<input autoFocus value={newMeetingTitle} onChange={(e)=>setNewMeetingTitle(e.target.value)} placeholder="e.g. Client discovery call" maxLength={100}/></label><div className="dateTimeFields"><label className="fieldLabel">Date<input type="date" value={newMeetingDate} onChange={(e)=>setNewMeetingDate(e.target.value)} required/></label><label className="fieldLabel">Time<input type="time" value={newMeetingTime} onChange={(e)=>setNewMeetingTime(e.target.value)} required/></label></div></div><div className="calendarCreateNote"><ShieldCheck size={15}/><span>Invited guests can join from the browser without an RP account. Calendar entries are local to this browser until email/calendar sync is added.</span></div><div className="dialogActions"><button type="button" className="secondaryButton" onClick={()=>setShowCreateMeeting(false)}>Cancel</button><button type="button" className="secondaryButton" onClick={scheduleMeeting}><CalendarClock size={15}/> Schedule</button><button type="button" className="primaryButton" onClick={()=>void startMeetingNow()}><Video size={15}/> Start now</button></div></section></div>}
      {showSettings&&<div className="dialogScrim" onMouseDown={(e)=>{if(e.target===e.currentTarget)setShowSettings(false)}}><section className="settingsDialog" role="dialog" aria-modal="true" aria-labelledby="settingsTitle"><button className="dialogClose" type="button" onClick={() => setShowSettings(false)} aria-label="Close"><X size={17}/></button><div className="dialogIcon"><Settings2 size={22}/></div><p className="eyebrow">CONNECTION HELP</p><h2 id="settingsTitle">RPcalls settings</h2><div className="settingsInfo"><div><strong>Realtime connection</strong><span>{realtimeConfigured?"Configured":"Not configured"}</span></div><div><strong>ICE servers</strong><span>{turnServers.length>1?"STUN + TURN":"STUN only"}</span></div></div><p className="turnHelpText">If guests on company or mobile networks cannot connect to each other, a TURN relay may be required. Configure VITE_TURN_URLS, VITE_TURN_USERNAME, and VITE_TURN_CREDENTIAL in the Vercel environment. The publishable Supabase key is meant for frontend use; never add a service-role or secret key here.</p><div className="dialogActions"><button type="button" className="secondaryButton" onClick={()=>setShowSettings(false)}>Close</button></div></section></div>}
    </div>
  );
}
