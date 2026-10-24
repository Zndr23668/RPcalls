import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, ArrowLeft, Check, CheckCheck, ChevronDown, CircleHelp, Copy,
  Headphones, Link2, MessageCircle, Mic, MicOff, MonitorUp, MoreHorizontal,
  Plus, Send, Settings2, ShieldCheck, Sparkles, Users, Video, VideoOff, Wifi,
  X, PhoneOff, Share2, CalendarClock, UserRoundPlus, PanelRight, Volume2,
} from "lucide-react";
import { realtimeConfigured, supabase } from "./lib/supabase";

type PresencePerson = {
  peerId: string;
  name: string;
  isHost?: boolean;
  micOn?: boolean;
  cameraOn?: boolean;
  raised?: boolean;
  joinedAt?: number;
};
type ChatMessage = { id: string; from: string; name: string; text: string; sentAt: number };
type Panel = "chat" | "people";

const randomId = (bytes = 20) => {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, (v) => v.toString(16).padStart(2, "0")).join("");
};
const hostStorageKey = (id: string) => `rpcalls:host:${id}`;
const safeName = (value: string) => value.trim().slice(0, 50);
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
  const [raised, setRaised] = useState(false);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [connectionState, setConnectionState] = useState("Ready");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [mediaWarning, setMediaWarning] = useState("");
  const [showInvite, setShowInvite] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [meetingTab, setMeetingTab] = useState<"overview" | "meetings" | "chats">("overview");
  const [chatSearch, setChatSearch] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [turnHelp, setTurnHelp] = useState(false);
  const [iceServersDraft, setIceServersDraft] = useState("");
  const [chatUnread, setChatUnread] = useState(0);

  const channelRef = useRef<any>(null);
  const peerIdRef = useRef("");
  const identityRef = useRef<{ peerId: string; name: string; isHost: boolean }>({ peerId: "", name: "", isHost: false });
  const presenceRef = useRef({ micOn: true, cameraOn: true, raised: false });
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const pcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const makingOfferRef = useRef<Set<string>>(new Set());
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const fileChooserRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (roomId) {
      let savedHost = false;
      try { savedHost = Boolean(sessionStorage.getItem(hostStorageKey(roomId))); } catch { /* restricted storage */ }
      setIsHost(savedHost);
    }
  }, [roomId]);

  useEffect(() => {
    try {
      if (displayName.trim()) localStorage.setItem("rpcalls:name", displayName.trim());
    } catch { /* storage is optional */ }
  }, [displayName]);

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

  const currentRoomLink = (id = roomId, mode: "meeting" | "chat" = roomMode) => {
    if (!id) return window.location.origin;
    return `${window.location.origin}/?${mode === "chat" ? "chat" : "meeting"}=${encodeURIComponent(id)}`;
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
    for (const person of list) {
      if (person.peerId !== peerIdRef.current && peerIdRef.current.localeCompare(person.peerId) < 0) {
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

  const getPeerConnection = (remoteId: string) => {
    const existing = pcsRef.current.get(remoteId);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: turnServers });
    pcsRef.current.set(remoteId, pc);
    const local = localStreamRef.current;
    local?.getTracks().forEach((track) => pc.addTrack(track, local));
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
    remoteStreamsRef.current.clear();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    screenStreamRef.current = null;
    setLocalStream(null);
    setScreenStream(null);
    setRemoteStreams({});
    setParticipants([]);
    setMessages([]);
    setJoined(false);
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

  const joinRoom = async (targetRoomId: string, hostOverride = false, mode: "meeting" | "chat" = roomMode) => {
    if (!targetRoomId || joined || busy) return;
    if (!supabase || !realtimeConfigured) {
      setMediaWarning("RPcalls is missing its Realtime connection settings. Ask the app administrator to configure Supabase.");
      setShowSettings(true);
      return;
    }
    const cleanName = safeName(displayName) || "Guest";
    const thisPeerId = randomId(12);
    const host = hostOverride || (() => {
      try { return Boolean(sessionStorage.getItem(hostStorageKey(targetRoomId))); } catch { return false; }
    })();
    setBusy(true);
    setMediaWarning("");
    setRoomId(targetRoomId);
    setRoomMode(mode);
    setIsHost(host);
    setDisplayName(cleanName);
    try { localStorage.setItem("rpcalls:name", cleanName); } catch { /* optional */ }
    history.replaceState(null, "", `/?${mode === "chat" ? "chat" : "meeting"}=${encodeURIComponent(targetRoomId)}`);
    peerIdRef.current = thisPeerId;
    identityRef.current = { peerId: thisPeerId, name: cleanName, isHost: host };
    setPeerId(thisPeerId);
    let stream: MediaStream | null = null;
    if (mode === "meeting") {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      } catch {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          setMediaWarning("Camera access was unavailable, so you joined with audio only. You can adjust permissions in your browser.");
        } catch {
          setMediaWarning("Microphone/camera permission was not granted. You can still join, chat, and try enabling devices from the call controls.");
        }
      }
    } else {
      setMediaWarning("");
    }
    localStreamRef.current = stream;
    setLocalStream(stream);
    const hasAudio = Boolean(stream?.getAudioTracks().some((track) => track.enabled));
    const hasVideo = Boolean(stream?.getVideoTracks().some((track) => track.enabled));
    setMuted(!hasAudio);
    setCameraOn(hasVideo);
    presenceRef.current = { micOn: hasAudio, cameraOn: hasVideo, raised: false };

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
      .on("broadcast", { event: "signal" }, ({ payload }: { payload: any }) => { void handleSignal(payload); })
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
        notify(roomMode === "chat" ? "The chat room was ended." : "The organizer ended this meeting.");
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

  const createMeeting = async () => {
    const id = randomId(20);
    try { sessionStorage.setItem(hostStorageKey(id), randomId(24)); } catch { /* host marker is optional */ }
    setRoomId(id);
    setIsHost(true);
    setMessages([]);
    setParticipants([]);
    await joinRoom(id, true, "meeting");
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

  const leaveMeeting = async (endForEveryone = false) => {
    const channel = channelRef.current;
    if (endForEveryone && channel && isHost) {
      try {
        await channel.send({ type: "broadcast", event: "meeting-ended", payload: { by: peerIdRef.current } });
      } catch { /* participant cleanup continues */ }
    }
    await cleanupMeeting();
    history.replaceState(null, "", "/");
    setRoomId(null);
    setRoomMode("meeting");
    setIsHost(false);
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
      window.prompt("Copy this meeting link and send it to your guest:", link);
    }
  };

  const shareInvite = async () => {
    if (!roomId) return;
    const url = currentRoomLink(roomId);
    if (navigator.share) {
      try { await navigator.share({ title: "Join my RPcalls meeting", text: "Join my meeting using this link:", url }); return; } catch { /* user cancelled or share unavailable */ }
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
    setIsHost(false);
    setMeetingTab("overview");
  };

  const remoteParticipants = participants.filter((person) => person.peerId !== peerId);
  const localPreview = screenStream || localStream;
  const totalParticipants = Math.max(participants.length, joined ? 1 : 0);

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
            <strong>{roomMode === "chat" ? "RPcalls chat" : "RPcalls meeting"}</strong>
            <span><span className="liveDot" />{connectionState} <i>·</i> {totalParticipants} participant{totalParticipants === 1 ? "" : "s"}</span>
          </div>
          <div className="meetingTopActions">
            <button className="outlineButton" type="button" onClick={shareInvite}><UserRoundPlus size={16} /> Invite</button>
            <button className="iconButton" aria-label="Meeting settings" onClick={() => setShowSettings(true)}><Settings2 size={17} /></button>
            <button className="iconButton" aria-label="Close meeting" onClick={() => void leaveMeeting(false)}><X size={18} /></button>
          </div>
        </header>
        <main className={`meetingWorkspace ${activePanel ? "panelOpen" : ""}`}>
          <section className="meetingStage">
            <div className="stageHeading">
              <div><p className="eyebrow">{roomMode === "chat" ? "LIVE CHAT" : "LIVE MEETING"}</p><h1>{roomMode === "chat" ? "Your conversation is ready." : "Good conversations start here."}</h1><p>Share your link to bring someone into the room.</p></div>
              <button className="subtleButton" type="button" onClick={() => setShowInvite(true)}><Link2 size={15} /> Meeting info</button>
            </div>
            {mediaWarning && <div className="inlineAlert"><AlertCircle size={16} /><span>{mediaWarning}</span><button type="button" onClick={() => setMediaWarning("")}><X size={14} /></button></div>}
            <div className={`videoGrid ${allTiles.length===1?"oneTile":allTiles.length===2?"twoTiles":allTiles.length>4?"manyTiles":""}`}>
              {allTiles.map((tile) => <VideoTile key={tile.id || "local"} name={tile.name} stream={tile.stream} muted={tile.local} local={tile.local} cameraOn={tile.cameraOn} isHost={tile.host} />)}
              {allTiles.length === 1 && <button type="button" className="emptyGuestCard" onClick={() => setShowInvite(true)}><span className="emptyGuestIcon"><UserRoundPlus size={24} /></span><strong>You're the first one here</strong><span>{roomMode === "chat" ? "Share this chat link to start messaging with someone." : "Invite someone outside your organization with a link."}</span><b>Invite a guest <Plus size={14}/></b></button>}
            </div>
            <div className="meetingControlDock">
              <div className="dockLeft"><span className="meetingTime"><Wifi size={14}/>{connectionState}</span></div>
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
                  <div className="composerActions"><span>Enter to send · Shift + Enter for a new line</span><button type="submit" disabled={!draft.trim()} aria-label="Send message"><Send size={16}/></button></div>
                </form>
              </>
            ) : (
              <div className="participantList">
                {participants.map((person) => <div key={person.peerId} className="participantRow"><div className="participantAvatar">{person.name?.charAt(0)?.toUpperCase()||"G"}{person.raised&&<span>✋</span>}</div><div className="participantInfo"><strong>{person.peerId===peerId?"You":person.name||"Guest"}{person.isHost&&<span className="hostPill">Organizer</span>}</strong><small>{person.peerId===peerId?"Meeting device":person.micOn===false?"Microphone muted":"In the meeting"}</small></div><div className="participantStatus">{person.micOn===false?<MicOff size={15}/>:<Mic size={15}/>} {person.cameraOn===false?<VideoOff size={15}/>:<Video size={15}/>}</div></div>)}
                {!participants.length&&<p className="muted smallText">Connecting to meeting participants…</p>}
                <button type="button" className="invitePeopleButton" onClick={() => setShowInvite(true)}><UserRoundPlus size={16}/> Invite someone</button>
              </div>
            )}
          </aside>
        </main>
        {showInvite && <div className="dialogScrim" onMouseDown={(e) => {if(e.target===e.currentTarget)setShowInvite(false)}}><section className="inviteDialog" role="dialog" aria-modal="true" aria-labelledby="inviteTitle"><button className="dialogClose" type="button" onClick={() => setShowInvite(false)} aria-label="Close"><X size={17}/></button><div className="dialogIcon"><Link2 size={22}/></div><p className="eyebrow">MEETING DETAILS</p><h2 id="inviteTitle">Invite anyone to RPcalls</h2><p className="dialogIntro">Send this link to colleagues, clients, or guests outside Remote Professionals. They can join from their browser without an RP account.</p><label className="fieldLabel">Meeting link<div className="copyLinkField"><input readOnly value={currentRoomLink()} aria-label="Meeting link"/><button type="button" onClick={() => void copyInvite()}>{inviteCopied?<Check size={16}/>:<Copy size={16}/>}<span>{inviteCopied?"Copied":"Copy"}</span></button></div></label><div className="guestAccessNote"><ShieldCheck size={17}/><span><strong>Anyone with the link can join.</strong> Treat the invitation as access to this meeting and share it only with intended participants.</span></div><div className="dialogActions"><button type="button" className="secondaryButton" onClick={() => setShowInvite(false)}>Done</button><button type="button" className="primaryButton" onClick={() => void shareInvite()}><Share2 size={16}/> Share invite</button></div></section></div>}
        {showSettings&&<div className="dialogScrim" onMouseDown={(e)=>{if(e.target===e.currentTarget)setShowSettings(false)}}><section className="settingsDialog" role="dialog" aria-modal="true" aria-labelledby="settingsTitle"><button className="dialogClose" type="button" onClick={()=>setShowSettings(false)} aria-label="Close"><X size={17}/></button><div className="dialogIcon"><Settings2 size={22}/></div><p className="eyebrow">DEVICE & CONNECTION</p><h2 id="settingsTitle">Meeting settings</h2><div className="settingsInfo"><div><strong>Realtime connection</strong><span>{realtimeConfigured?"Configured":"Not configured"}</span></div><div><strong>ICE servers</strong><span>{turnServers.length>1?"STUN + TURN":"STUN only"}</span></div><div><strong>Connection status</strong><span>{connectionState}</span></div></div><button type="button" className="turnHelpToggle" onClick={()=>setTurnHelp(!turnHelp)}><CircleHelp size={16}/> Why use a TURN server? <ChevronDown size={15}/></button>{turnHelp&&<p className="turnHelpText">STUN-only calls work on many networks, but strict corporate firewalls and some mobile networks require TURN relay. Add VITE_TURN_URLS, VITE_TURN_USERNAME, and VITE_TURN_CREDENTIAL to the Vercel environment to enable it.</p>}<div className="dialogActions"><button type="button" className="secondaryButton" onClick={()=>setShowSettings(false)}>Close</button></div></section></div>}
      </div>
    );
  }

  if (roomId) {
    return (
      <div className="joinPage">
        <header className="joinHeader"><a className="brandLink" href="/" onClick={(e)=>{e.preventDefault();closeJoin()}}><span className="brandMark">RP</span><strong>RPcalls</strong></a><span className="joinHeaderSecure"><ShieldCheck size={15}/> Browser-based meeting</span></header>
        <main className="joinGrid">
          <section className="joinCard">
            <div className="joinIllustration"><div className="illustrationCircle circleOne"/><div className="illustrationCircle circleTwo"/><div className="illustrationCallCard"><Video size={21}/><span>RPcalls</span><div><i/><i/><i/></div></div><div className="illustrationBadge"><Users size={18}/></div></div>
            <p className="eyebrow">YOU'RE INVITED</p><h1>Join the conversation.</h1><p className="joinDescription">{roomMode === "chat" ? "You’re joining an RPcalls chat. Enter your name and start messaging — no Remote Professionals account required." : "You’re joining an RPcalls meeting. Enter your name and hop in — no Remote Professionals account required."}</p>
            <form onSubmit={(e)=>{e.preventDefault();void joinRoom(roomId,isHost,roomMode)}} className="joinForm">
              <label className="fieldLabel">Your name<input autoFocus value={displayName} onChange={(e)=>setDisplayName(e.target.value)} placeholder="How should we call you?" maxLength={50} required/></label>
              {mediaWarning&&<div className="inlineAlert"><AlertCircle size={16}/><span>{mediaWarning}</span><button type="button" onClick={()=>setMediaWarning("")}><X size={14}/></button></div>}
              {!realtimeConfigured&&<div className="inlineAlert"><AlertCircle size={16}/><span>Meeting service is not configured yet. The administrator needs to set the Supabase environment variables.</span></div>}
              <button className="primaryButton joinSubmit" type="submit" disabled={busy||!displayName.trim()||!realtimeConfigured}>{busy?"Preparing your meeting…":"Join meeting"}<ArrowLeft size={16} className="joinArrow"/></button>
            </form>
            <div className="joinDisclaimer"><ShieldCheck size={15}/><span>Only join meeting links you trust. Anyone with this link may be able to enter.</span></div>
          </section>
          <aside className="joinAside"><div className="joinQuote"><Sparkles size={18}/><h2>Meet more naturally.</h2><p>Talk face-to-face, share what you’re working on, and keep the conversation moving.</p></div><div className="joinFeature"><span><Mic size={17}/></span><div><strong>Voice & video</strong><small>Choose your devices once you join</small></div></div><div className="joinFeature"><span><MessageCircle size={17}/></span><div><strong>Shared meeting chat</strong><small>Send messages while you talk</small></div></div><div className="joinFeature"><span><MonitorUp size={17}/></span><div><strong>Screen sharing</strong><small>Present your screen to the room</small></div></div></aside>
        </main>
        <footer className="joinFooter"><span>RPcalls · Meetings for every team</span><button type="button" onClick={() => setShowSettings(true)}><Settings2 size={14}/> Connection help</button></footer>
        {showSettings&&<div className="dialogScrim" onMouseDown={(e)=>{if(e.target===e.currentTarget)setShowSettings(false)}}><section className="settingsDialog" role="dialog" aria-modal="true" aria-labelledby="settingsTitle"><button className="dialogClose" type="button" onClick={() => setShowSettings(false)} aria-label="Close"><X size={17}/></button><div className="dialogIcon"><Settings2 size={22}/></div><p className="eyebrow">CONNECTION HELP</p><h2 id="settingsTitle">RPcalls settings</h2><div className="settingsInfo"><div><strong>Realtime connection</strong><span>{realtimeConfigured?"Configured":"Not configured"}</span></div><div><strong>STUN servers</strong><span>Available</span></div><div><strong>TURN relay</strong><span>{turnServers.length>1?"Configured":"Optional — not configured"}</span></div></div><p className="turnHelpText">If a call cannot connect on a company network, a TURN relay may be required. Ask the administrator to configure TURN in Vercel.</p><div className="dialogActions"><button type="button" className="secondaryButton" onClick={() => setShowSettings(false)}>Close</button></div></section></div>}
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
          <button type="button" className={meetingTab==="meetings"?"selected":""} onClick={()=>setMeetingTab("meetings")}><CalendarClock size={18}/> Meetings</button>
          <button type="button" className={meetingTab==="chats"?"selected":""} onClick={()=>setMeetingTab("chats")}><MessageCircle size={18}/> Chats</button>
        </nav>
        <div className="sidebarBottom"><div className="sidebarHelpCard"><span><Headphones size={17}/></span><strong>Need help?</strong><small>Check your connection and browser permissions.</small><button type="button" onClick={()=>setShowSettings(true)}>Connection settings <ArrowLeft size={13}/></button></div><div className="profileMini"><div className="profileMiniAvatar">{displayName.trim().charAt(0).toUpperCase()||"G"}</div><div><strong>{safeName(displayName)||"Guest user"}</strong><small>RPcalls guest</small></div><button type="button" aria-label="Profile options" onClick={()=>setShowSettings(true)}><MoreHorizontal size={17}/></button></div></div>
      </aside>
      <main className="homeMain">
        <header className="homeTopbar"><div className="crumb">Workspace <span>/</span> {meetingTab==="overview"?"Overview":"Meetings"}</div><div className="topbarActions"><span className="topbarStatus"><span className="liveDot"/> Realtime calls</span><button className="iconButton" aria-label="Settings" onClick={()=>setShowSettings(true)}><Settings2 size={18}/></button><div className="profileMiniAvatar topAvatar">{displayName.trim().charAt(0).toUpperCase()||"G"}</div></div></header>
        <div className="homeContent">
          {meetingTab==="overview" ? <>
            <section className="homeHero">
              <div className="homeHeroCopy"><div className="heroTag"><span/><span>Say hello to easier conversations</span></div><h1>Meet with anyone.<br/><em>From anywhere.</em></h1><p>One simple link to talk, share your screen, and chat with your team — or a guest outside your organization.</p><div className="heroActions"><button type="button" className="primaryButton" onClick={()=>void createMeeting()}><Video size={18}/> Start a new meeting</button><button type="button" className="secondaryButton" onClick={()=>{const input=document.getElementById("join-link-input") as HTMLInputElement|null;input?.focus()}}><Link2 size={17}/> Join with a link</button></div><div className="heroTrust"><ShieldCheck size={14}/> No org account required for guests <span>·</span> Works in your browser</div></div>
              <div className="heroVisual" aria-hidden="true"><div className="visualBackdrop backdropOne"/><div className="visualBackdrop backdropTwo"/><div className="visualWindow"><div className="visualWindowTop"><span/><span/><span/><b>RPcalls</b><MoreHorizontal size={16}/></div><div className="visualPeople"><div className="visualPerson personA"><b>J</b><span/><small>Jordan Lee</small></div><div className="visualPerson personB"><b>M</b><span/><small>Maya Chen</small></div><div className="visualPerson personC"><b>R</b><span/><small>Riley Park</small></div><div className="visualPerson personD"><b>Y</b><span/><small>You</small></div></div><div className="visualControls"><i/><i/><i/><b><PhoneOff size={14}/></b></div></div><div className="floatChip chipInvite"><UserRoundPlus size={15}/><span>Guest joined</span><Check size={14}/></div><div className="floatChip chipShare"><MonitorUp size={15}/><span>Screen sharing</span></div></div>
            </section>
            <section className="quickActions"><div className="sectionHeading"><div><p className="eyebrow">GET STARTED</p><h2>Ready when you are</h2></div><span>Simple tools for better conversations</span></div><div className="quickActionGrid"><button type="button" className="quickActionCard" onClick={()=>void createMeeting()}><span className="quickIcon purple"><Video size={20}/></span><strong>Start a meeting</strong><small>Open a room and invite anyone with a link.</small><i><ArrowLeft size={16}/></i></button><button type="button" className="quickActionCard" onClick={()=>{const input=document.getElementById("join-link-input") as HTMLInputElement|null;input?.focus()}}><span className="quickIcon blue"><Link2 size={20}/></span><strong>Join a meeting</strong><small>Paste a meeting URL shared with you.</small><i><ArrowLeft size={16}/></i></button><button type="button" className="quickActionCard" onClick={()=>setShowSettings(true)}><span className="quickIcon orange"><Settings2 size={20}/></span><strong>Check your setup</strong><small>Review camera, microphone, and network readiness.</small><i><ArrowLeft size={16}/></i></button></div></section>
            <section className="joinByLinkCard"><div className="joinByIcon"><Link2 size={19}/></div><div className="joinByCopy"><strong>Have a meeting link?</strong><span>Paste it here to join an existing RPcalls meeting.</span></div><form onSubmit={(e)=>{e.preventDefault();const input=document.getElementById("join-link-input") as HTMLInputElement|null;if(!input)return;try{const value=new URL(input.value.trim());const id=value.searchParams.get("meeting")||value.pathname.split("/").filter(Boolean).pop();if(!id)throw new Error("No meeting ID found");setRoomId(id);setIsHost(false);history.replaceState(null,"",`/?meeting=${encodeURIComponent(id)}`);}catch{notify("That link does not look like a valid RPcalls invite.");}}}><input id="join-link-input" placeholder="Paste an RPcalls meeting link" type="url" aria-label="Meeting link" required/><button className="secondaryButton" type="submit">Join</button></form></section>
          </> : <section className="meetingsPage"><div className="meetingsPageHeading"><div><p className="eyebrow">YOUR SPACE</p><h1>Meetings</h1><p>Start a fresh call or join a room someone has shared with you.</p></div><button type="button" className="primaryButton" onClick={()=>void createMeeting()}><Plus size={17}/> New meeting</button></div><div className="meetingEmptyState"><span><CalendarClock size={25}/></span><h2>Your next conversation starts here.</h2><p>RPcalls uses shareable meeting links. You can invite coworkers or people outside your organization without making them create an account.</p><button type="button" className="primaryButton" onClick={()=>void createMeeting()}><Video size={17}/> Start a new meeting</button></div><div className="meetingPolicyNote"><ShieldCheck size={17}/><span>Meeting rooms are not listed publicly. Anyone with a meeting invite link can join, so share links only with intended guests.</span></div></section>}
        </div>
        <footer className="homeFooter"><span>© RPcalls · Built for thoughtful conversations</span><div><button type="button" onClick={()=>setShowSettings(true)}>Connection help</button><span>·</span><span>Guest-friendly meetings</span></div></footer>
      </main>
      {notice&&<div className="toastNotice" role="status"><CheckCheck size={17}/>{notice}</div>}
      {showSettings&&<div className="dialogScrim" onMouseDown={(e)=>{if(e.target===e.currentTarget)setShowSettings(false)}}><section className="settingsDialog" role="dialog" aria-modal="true" aria-labelledby="settingsTitle"><button className="dialogClose" type="button" onClick={() => setShowSettings(false)} aria-label="Close"><X size={17}/></button><div className="dialogIcon"><Settings2 size={22}/></div><p className="eyebrow">CONNECTION HELP</p><h2 id="settingsTitle">RPcalls settings</h2><div className="settingsInfo"><div><strong>Realtime connection</strong><span>{realtimeConfigured?"Configured":"Not configured"}</span></div><div><strong>ICE servers</strong><span>{turnServers.length>1?"STUN + TURN":"STUN only"}</span></div></div><p className="turnHelpText">If guests on company or mobile networks cannot connect to each other, a TURN relay may be required. Configure VITE_TURN_URLS, VITE_TURN_USERNAME, and VITE_TURN_CREDENTIAL in the Vercel environment. The publishable Supabase key is meant for frontend use; never add a service-role or secret key here.</p><div className="dialogActions"><button type="button" className="secondaryButton" onClick={()=>setShowSettings(false)}>Close</button></div></section></div>}
    </div>
  );
}
