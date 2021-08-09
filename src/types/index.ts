import type {types} from "mediasoup-client";

export interface WebRTCStatsConstructorOptions {
    getStatsInterval: number;
    rawStats?: boolean;
    statsObject?: boolean;
    filteredStats?: boolean;
    wrapGetUserMedia?: boolean;
    debug?: boolean;
    remote?: boolean;
    logLevel?: LogLevel;
}

/**
 * none: Show nothing at all.
 * error: Log all errors.
 * warn: Only log all warnings and errors.
 * info: Informative messages including warnings and errors.
 * debug: Show everything including debugging information
 */
export type LogLevel = "none" | "error" | "warn" | "info" | "debug";

export type TimelineTag = "getUserMedia" | "peer" | "connection" | "track" | "datachannel" | "stats";

export interface TransportsInfo {
    send?: types.Transport;
    recv?: types.Transport;
    sendPC?: RTCPeerConnection;
    recvPC?: RTCPeerConnection;
    peerId: string;
}

export interface TimelineEvent {
    event: string;
    tag: TimelineTag;
    timestamp?: Date;
    data?: any;
    prev?: any;
    peerId?: string;
    error?: any;
    rawStats?: RTCStatsReport[];
    statsObject?: any;
    filteredStats?: any;
    appData?: any;
}

export interface AddPeerOptions {
    sendTransport?: types.Transport;
    recvTransport?: types.Transport;
    peerId: string;
    remote?: boolean;
}

export interface GetUserMediaResponse {
    constraints?: MediaStreamConstraints;
    stream?: MediaStream;
    error?: DOMError;
}

export interface MonitoredPeer {
    info: TransportsInfo;
    stream: MediaStream | null;
    stats: any;
    options: MonitorPeerOptions;
}

export interface MonitoredPeersObject {
    [index: string]: MonitoredPeer;
}

export interface TrackReport extends RTCTransportStats {
    bitrate?: number | null;
    packetRate?: number | null;
    track?: MediaTrackSettings;
    appData?: any;
    [key: string]: any;
}

interface StatsObjectDetails {
    inbound: TrackReport[];
    outbound: TrackReport[];
}

export interface StatsObject {
    audio: StatsObjectDetails;
    video: StatsObjectDetails;
    remote?: {
        audio: StatsObjectDetails
        video: StatsObjectDetails
    };
    connection: any;
}

export interface CodecInfo {
    clockRate: number;
    mimeType: number;
    payloadType: number;
}

export interface MonitorPeerOptions {
    remote: boolean;
}

export interface ParseStatsOptions {
    remote?: boolean;
}

export type PeerListener = (transport: types.Transport, pc: RTCPeerConnection, peerId: string, ev?: any) => void;

export interface PeerListenersMap {
    icecandidate: PeerListener;
    track: PeerListener;
    signalingstatechange: PeerListener;
    iceconnectionstatechange: PeerListener;
    icegatheringstatechange: PeerListener;
    icecandidateerror: PeerListener;
    connectionstatechange: PeerListener;
    negotiationneeded: PeerListener;
    datachannel: PeerListener;
}

export interface MediaTrackDetails {
    settings: MediaTrackSettings;
    constructorName: string;
    capabilities: MediaTrackCapabilities;
    kind: string;
    contentHint: any;
    _track: MediaStreamTrack;
    readyState: "ended" | "live";
    id: string;
    label: string;
    muted: boolean;
    constraints: MediaTrackConstraints;
    enabled: boolean;
}
