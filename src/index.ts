import {EventEmitter} from "@livelyvideo/events-typed";
import {
    WebRTCStatsConstructorOptions,
    AddPeerOptions,
    MonitoredPeersObject,
    TimelineEvent,
    TimelineTag,
    GetUserMediaResponse,
    MonitorPeerOptions,
    ParseStatsOptions,
    LogLevel,
    PeerListenersMap,
    TransportsInfo,
    MediaTrackDetails,
    StatsObject,
    TrackReport,
} from "./types/index";

import { parseStats, map2obj } from "./utils";

import throttledQueue from 'throttled-queue';

export {
    WebRTCStatsConstructorOptions,
    AddPeerOptions,
    MonitoredPeersObject,
    TimelineEvent,
    TimelineTag,
    GetUserMediaResponse,
    MonitorPeerOptions,
    ParseStatsOptions,
    LogLevel,
    PeerListenersMap,
    TransportsInfo,
    MediaTrackDetails,
    StatsObject,
    TrackReport,
};

export class WebRTCStats extends EventEmitter {
    private readonly isEdge: boolean;
    private _getStatsInterval: number = 5000;
    private monitoringSetInterval: number | undefined;
    private connectionMonitoringSetInterval: number = 0;
    private connectionMonitoringInterval: number = 1000;
    private readonly rawStats: boolean;
    private readonly statsObject: boolean;
    private readonly filteredStats: boolean;
    private readonly shouldWrapGetUserMedia: boolean;
    private debug: any;
    private readonly remote: boolean = true;
    private peersToMonitor: MonitoredPeersObject = {};
    private logLevel: LogLevel;

    /**
     * Used to keep track of all the events
     */
    private timeline: TimelineEvent[] = [];

    /**
     * A list of stats to look after
     */
    private statsToMonitor: string[] = [
        "inbound-rtp",
        "outbound-rtp",
        "remote-inbound-rtp",
        "remote-outbound-rtp",
        "peer-connection",
        "data-channel",
        "stream",
        "track",
        "sender",
        "receiver",
        "transport",
        "candidate-pair",
        "local-candidate",
        "remote-candidate",
    ];

    constructor(constructorOptions: WebRTCStatsConstructorOptions) {
        super();

        // only works in the browser
        if (typeof window === "undefined") {
            throw new Error("WebRTCStats only works in browser");
        }

        const options = {...constructorOptions};

        this.isEdge = !!window.RTCIceGatherer;

        this.getStatsInterval = options.getStatsInterval || 1000;
        this.rawStats = !!options.rawStats;
        this.statsObject = !!options.statsObject;
        this.filteredStats = !!options.filteredStats;

        // getUserMedia options
        this.shouldWrapGetUserMedia = !!options.wrapGetUserMedia;

        if (typeof options.remote === "boolean") {
            this.remote = options.remote;
        }

        // If we want to enable debug
        this.debug = !!options.debug;
        this.logLevel = options.logLevel || "none";

        // add event listeners for getUserMedia
        if (this.shouldWrapGetUserMedia) {
            this.wrapGetUserMedia();
        }
    }

    /**
     * Start tracking a RTCPeerConnection
     * @param {Object} options The options object
     */
    public async addPeer(options: AddPeerOptions): Promise<void> {
        const peerId = options.peerId;
        let sendTransport = options.sendTransport;
        let recvTransport = options.recvTransport;
        let sendPC = (sendTransport?.handler as any)?._pc as RTCPeerConnection | undefined;
        let recvPC = (recvTransport?.handler as any)?._pc as RTCPeerConnection | undefined;
        let {remote} = options;

        const info = this.peersToMonitor[peerId]?.info;
        if (info) {
            if (info.send != null && sendTransport == null) {
                sendTransport = info.send;
                sendPC = (sendTransport as any)._pc as RTCPeerConnection;
            }

            if (info.recv != null && recvTransport == null) {
                recvTransport = info.recv;
                recvPC = (recvTransport as any)._pc as RTCPeerConnection;
            }
        }

        if (!peerId) {
            throw new Error('Missing argument peerId')
        }

        remote = typeof remote === "boolean" ? remote : this.remote;

        if (!(sendPC instanceof RTCPeerConnection) && !(recvPC instanceof RTCPeerConnection)) {
            throw new Error(`At least one Transport argument is missing or incorrect`);
        }

        const transports: TransportsInfo = {
            send: sendTransport,
            recv: recvTransport,
            sendPC: sendPC,
            recvPC: recvPC,
            peerId: peerId,
        };

        if (this.isEdge) {
            throw new Error("Can't monitor peers in Edge at this time.");
        }

        if (info != null) {
            // remove an existing peer with same id if that peer is already closed.
            this.removePeer(info.peerId);
        }

        const sendConfig = sendPC?.getConfiguration();
        const recvConfig = recvPC?.getConfiguration();

        // don't log credentials
        if (sendConfig?.iceServers) {
            sendConfig.iceServers.forEach(function (server) {
                delete server.credential;
            });
        }

        if (recvConfig?.iceServers) {
            recvConfig.iceServers.forEach(function (server) {
                delete server.credential;
            });
        }

        this.emitEvent({
            event: "addPeer",
            tag: "peer",
            peerId: peerId,
            data: {
                options: options,
                sendConfig,
                recvConfig,
            },
        });

        this.monitorPeer(transports, {remote});
    }

    /**
     * Returns the timeline of events
     * If a tag is it will filter out events based on it
     * @param  {String} tag The tag to filter events (optional)
     * @return {Array}     The timeline array (or sub array if tag is defined)
     */
    public getTimeline(tag: TimelineTag): TimelineEvent[] {
        // sort the events by timestamp
        this.timeline = this.timeline.sort(
            (event1, event2) => (event1.timestamp?.getTime() ?? 0) - (event2.timestamp?.getTime() ?? 0),
        );

        if (tag) {
            return this.timeline.filter((event) => event.tag === tag);
        }

        return this.timeline;
    }

    /**
     * Used to add to the list of peers to get stats for
     * @param info
     * @param {MonitorPeerOptions} options
     */
    private monitorPeer(info: TransportsInfo, options: MonitorPeerOptions): void {
        // keep this in an object to avoid duplicates
        this.peersToMonitor[info.peerId] = {
            info,
            stream: null,
            stats: {
                // keep a reference of the current stat
                parsed: null,
                raw: null,
            },
            options,
        };

        this.addPeerConnectionEventListeners(info);

        // start monitoring from the first peer added
        if (Object.keys(this.peersToMonitor).length === 1) {
            this.startStatsMonitoring();
            this.startConnectionStateMonitoring();
        }
    }

    /**
     * Used to start the setTimeout and request getStats from the peers
     */
    private startStatsMonitoring(): void {
        if (this.monitoringSetInterval) return;

        this.monitoringSetInterval = window.setInterval(() => {
            // if we ran out of peers to monitor
            if (!Object.keys(this.peersToMonitor).length) {
                this.stopStatsMonitoring();
            }

            this.getStats() // get stats from all peer connections
                .then((statsEvents: TimelineEvent[]) => {
                    statsEvents.forEach((statsEventObject: TimelineEvent) => {
                        // add it to the timeline and also emit the stats event
                        this.emitEvent(statsEventObject);
                    });
                });
        }, this._getStatsInterval);
    }

    private stopStatsMonitoring(): void {
        if (this.monitoringSetInterval) {
            window.clearInterval(this.monitoringSetInterval);
            this.monitoringSetInterval = 0;
        }
    }

    private async getStats(id: string | null = null): Promise<TimelineEvent[]> {
        this.logger.info(id ? `Getting stats from peer ${id}` : `Getting stats from all peers`);
        let peersToAnalyse: MonitoredPeersObject = {};

        // if we want the stats for a specific peer
        if (id) {
            peersToAnalyse[id] = this.peersToMonitor[id];
            if (!peersToAnalyse[id]) {
                throw new Error(`Cannot get stats. Peer with id ${id} does not exist`);
            }
        } else {
            // else, get stats for all of them
            peersToAnalyse = this.peersToMonitor;
        }

        let statsEventList: TimelineEvent[] = [];

        for (const id in peersToAnalyse) {
            const peerObject = this.peersToMonitor[id];
            const send = peerObject.info.send;
            const recv = peerObject.info.recv;

            // if this connection is closed, continue
            if (this.isConnectionClosed(peerObject.info)) {
                continue;
            }

            try {
                let statsObject: Record<string, unknown> = {};

                const producers: any /* types.Consumer[] */ = Array.from((send as any)?._producers ?? new Map(), ([k, v]) => v);
                const consumers: any /* types.Producer[] */ = Array.from((recv as any)?._consumers ?? new Map(), ([k, v]) => v);

              const throttle = throttledQueue(1, 5000);
              
              const producersStats = await throttle(() => { Promise.all(producers.map((p: any) => p.getStats())) });
              const consumersStats = await throttle(() => { Promise.all(consumers.map((c: any) => c.getStats())) });

                for (let i = 0; i < producersStats.length; i++) {
                    producersStats[i] = map2obj(
                        producersStats[i],
                        {producerId: producers[i].id, appData: producers[i].appData, track: producers[i].track?.getSettings()},
                        statsObject
                    );
                }

                for (let i = 0; i < consumersStats.length; i++) {
                    consumersStats[i] = map2obj(
                        consumersStats[i],
                        {consumerId: consumers[i].id, appData: consumers[i].appData, track: consumers[i].track?.getSettings()},
                        statsObject
                    );
                }

                const allReports = [...producersStats, ...consumersStats] as any;

                if (Object.keys(statsObject).length > 0) {
                    const parseStatsOptions: ParseStatsOptions = {remote: peerObject.options.remote};
                    const parsedStats = parseStats(allReports, peerObject.stats.parsed, parseStatsOptions);

                    const statsEventObject = {
                        event: "stats",
                        tag: "stats",
                        peerId: id,
                        data: parsedStats,
                        prev: peerObject.stats.parsed,
                    } as TimelineEvent;

                    if (this.rawStats) {
                        statsEventObject["rawStats"] = allReports;
                    }
                    if (this.statsObject) {
                        statsEventObject["statsObject"] = statsObject;
                    }
                    if (this.filteredStats) {
                        statsEventObject["filteredStats"] = this.filteroutStats(statsObject);
                    }

                    statsEventList.push(statsEventObject);

                    peerObject.stats.parsed = parsedStats;

                } else {
                    this.logger.error(`PeerConnection from peer ${id} did not return any stats data`);
                }
            } catch (e) {
                this.logger.error(e);
            }
        }

        return statsEventList;
    }

    private startConnectionStateMonitoring(): void {
        this.connectionMonitoringSetInterval = window.setInterval(() => {
            if (!Object.keys(this.peersToMonitor).length) {
                this.stopConnectionStateMonitoring();
            }

            for (const id in this.peersToMonitor) {
                const peerObject = this.peersToMonitor[id];
                const info = peerObject.info;

                this.isConnectionClosed(info);
            }
        }, this.connectionMonitoringInterval);
    }

    private isConnectionClosed(info: TransportsInfo): boolean {
        if ((info.send == null || info.send.closed) && (info.recv == null || info.recv.closed)) {
            // event name should be deppending on what we detect as closed
            const event = "onconnectionstatechange";
            this.emitEvent({
                event,
                tag: "connection",
                peerId: info.peerId,
                data: "closed",
                appData: {send: info.send?.appData, recv: info.recv?.appData},
            });
            this.removePeer(info.peerId);
            return true;
        }

        return false;
    }

    private stopConnectionStateMonitoring(): void {
        if (this.connectionMonitoringSetInterval) {
            window.clearInterval(this.connectionMonitoringSetInterval);
            this.connectionMonitoringSetInterval = 0;
        }
    }

    private wrapGetUserMedia(): void {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            this.logger.warn(`'navigator.mediaDevices.getUserMedia' is not available in browser. Will not wrap getUserMedia.`);
            return;
        }

        this.logger.info("Wrapping getUsermedia functions.");

        const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

        const getUserMediaCallback = this.parseGetUserMedia.bind(this);
        const gum = function () {
            // the first call will be with the constraints
            getUserMediaCallback({constraints: arguments[0]});

            return origGetUserMedia.apply(navigator.mediaDevices, arguments as any)
                .then((stream) => {
                    getUserMediaCallback({stream: stream});
                    return stream;
                }, (err) => {
                    getUserMediaCallback({error: err});
                    return Promise.reject(err);
                });
        };

        // replace the native method
        navigator.mediaDevices.getUserMedia = gum.bind(navigator.mediaDevices);
    }


    /**
     * Filter out some stats, mainly codec and certificate
     * @param  {Object} stats The parsed rtc stats object
     * @return {Object}       The new object with some keys deleted
     */
    private filteroutStats(stats: Record<string, any> = {}): object {
        const fullObject = {...stats};
        for (const key in fullObject) {
            var stat = fullObject[key];
            if (!this.statsToMonitor.includes(stat?.type)) {
                delete fullObject[key];
            }
        }

        return fullObject;
    }

    private readonly peerConnectionListeners: Record<string, {send: Partial<PeerListenersMap>, recv: Partial<PeerListenersMap>}> = {};

    private get peerConnectionListenersMap(): PeerListenersMap {
        return {
            icecandidate: (transport, pc, peerId, ev) => {
                this.logger.debug("[pc-event] icecandidate | peerId: ${peerId}", ev);

                this.emitEvent({
                    event: "onicecandidate",
                    tag: "connection",
                    peerId,
                    data: ev.candidate,
                    appData: transport.appData,
                });
            },
            track: (transport, pc, peerId, ev) => {
                this.logger.debug(`[pc-event] track | peerId: ${peerId}`, ev);

                const track = ev.track;
                const stream = ev.streams[0];

                // save the remote stream
                this.peersToMonitor[peerId].stream = stream;

                this.addTrackEventListeners(track);
                this.emitEvent({
                    event: "ontrack",
                    tag: "track",
                    peerId: peerId,
                    data: {
                        stream: stream ? this.getStreamDetails(stream) : null,
                        track: track ? this.getMediaTrackDetails(track) : null,
                        title: ev.track.kind + ":" + ev.track.id + " " + ev.streams.map(function (stream: MediaStream) {
                            return "stream:" + stream.id;
                        }),
                    },
                    appData: transport.appData,
                });
            },
            signalingstatechange: (transport, pc, peerId, ev) => {
                this.logger.debug(`[pc-event] signalingstatechange | peerId: ${peerId}`);
                this.emitEvent({
                    event: "onsignalingstatechange",
                    tag: "connection",
                    peerId: peerId,
                    data: {
                        signalingState: pc.signalingState,
                        localDescription: pc.localDescription,
                        remoteDescription: pc.remoteDescription,
                    },
                    appData: transport.appData,
                });
            },
            iceconnectionstatechange: (transport, pc, peerId, ev) => {
                this.logger.debug(`[pc-event] iceconnectionstatechange | peerId: ${peerId}`);
                this.emitEvent({
                    event: "oniceconnectionstatechange",
                    tag: "connection",
                    peerId,
                    data: pc.iceConnectionState,
                    appData: transport.appData,
                });
            },
            icegatheringstatechange: (transport, pc, peerId, ev) => {
                this.logger.debug(`[pc-event] icegatheringstatechange | peerId: ${peerId}`);
                this.emitEvent({
                    event: "onicegatheringstatechange",
                    tag: "connection",
                    peerId,
                    data: pc.iceGatheringState,
                    appData: transport.appData,
                });
            },
            icecandidateerror: (transport, pc, peerId, ev) => {
                this.logger.debug(`[pc-event] icecandidateerror | peerId: ${peerId}`);
                this.emitEvent({
                    event: "onicecandidateerror",
                    tag: "connection",
                    peerId,
                    error: {
                        errorCode: ev.errorCode,
                    },
                    appData: transport.appData,
                });
            },
            connectionstatechange: (transport, pc, peerId, e) => {
                this.logger.debug(`[pc-event] connectionstatechange | peerId: ${peerId}`);
                this.emitEvent({
                    event: "onconnectionstatechange",
                    tag: "connection",
                    peerId,
                    data: pc.connectionState,
                    appData: transport.appData,
                });
            },
            negotiationneeded: (transport, pc, peerId, e) => {
                this.logger.debug(`[pc-event] negotiationneeded | peerId: ${peerId}`);
                this.emitEvent({
                    event: "onnegotiationneeded",
                    tag: "connection",
                    peerId,
                    appData: transport.appData,
                });
            },
            datachannel: (transport, pc, peerId, ev) => {
                this.logger.debug(`[pc-event] datachannel | peerId: ${peerId}`, ev);
                this.emitEvent({
                    event: "ondatachannel",
                    tag: "datachannel",
                    peerId,
                    data: ev.channel,
                    appData: transport.appData,
                });
            },
        };
    }

    private addPeerConnectionEventListeners(info: TransportsInfo): void {
        const id = info.peerId;

        this.logger.info(`Adding new peer with ID ${id}.`);
        this.logger.debug(`Newly added PeerConnection`, info.peerId);

        (Object.keys(this.peerConnectionListenersMap) as Array<keyof PeerListenersMap>).forEach((eventName) => {
            if (this.peerConnectionListeners[id] == null) {
                this.peerConnectionListeners[id] = {
                    send: {},
                    recv: {},
                };
            }

            if (info.send != null && info.sendPC != null) {
                const listener = this.peerConnectionListenersMap[eventName].bind(this, info.send, info.sendPC, info.peerId);
                this.peerConnectionListeners[id].send[eventName] = listener;
                info.sendPC.addEventListener(eventName, listener);
            }

            if (info.recv != null && info.recvPC != null) {
                const listener = this.peerConnectionListenersMap[eventName].bind(this, info.recv, info.recvPC, info.peerId);
                this.peerConnectionListeners[id].recv[eventName] = listener;
                info.recvPC.addEventListener(eventName, listener);
            }
        });
    }

    /**
     * Called when we get the stream from getUserMedia. We parse the stream and fire events
     * @param  {Object} options
     */
    private parseGetUserMedia(options: GetUserMediaResponse) {
        const obj = {
            event: "getUserMedia",
            tag: "getUserMedia",
            data: {...options},
        } as TimelineEvent;

        // if we received the stream, get the details for the tracks
        if (options.stream) {
            obj.data.details = this.parseStream(options.stream);
        }

        this.emitEvent(obj);
    }

    private parseStream(stream: MediaStream) {
        const result: Record<string, MediaTrackDetails[]> = {
            audio: [],
            video: [],
        };

        const tracks = stream.getTracks();
        tracks.forEach((track) => {
            result[track.kind].push(this.getMediaTrackDetails(track));
        });

        return result;
    }

    private getMediaTrackDetails(track: MediaStreamTrack): MediaTrackDetails {
        return {
            enabled: track.enabled,
            id: track.id,
            contentHint: (track as any).contentHint,
            kind: track.kind,
            label: track.label,
            muted: track.muted,
            readyState: track.readyState,
            constructorName: track.constructor.name,
            capabilities: track.getCapabilities ? track.getCapabilities() : {},
            constraints: track.getConstraints ? track.getConstraints() : {},
            settings: track.getSettings ? track.getSettings() : {},
            _track: track,
        };
    }

    private getStreamDetails(stream: MediaStream) {
        return {
            active: stream.active,
            id: stream.id,
            _stream: stream,
        };
    }

    /**
     * Add event listeners for the tracks that are added to the stream
     * @param {MediaStreamTrack} track
     */
    private addTrackEventListeners(track: MediaStreamTrack) {
        track.addEventListener("mute", (ev) => {
            this.emitEvent({
                event: "mute",
                tag: "track",
                data: {
                    event: ev,
                },
            });
        });
        track.addEventListener("unmute", (ev) => {
            this.emitEvent({
                event: "unmute",
                tag: "track",
                data: {
                    event: ev,
                },
            });
        });
        track.addEventListener("overconstrained", (ev) => {
            this.emitEvent({
                event: "overconstrained",
                tag: "track",
                data: {
                    event: ev,
                },
            });
        });

        track.addEventListener("ended", (ev) => {
            this.emitEvent({
                event: "ended",
                tag: "track",
                data: {
                    event: ev,
                },
            });
        });
    }

    private addToTimeline(event: TimelineEvent) {
        this.timeline.push(event);
        this.emit("timeline", event);
    }

    /**
     * Used to emit a custom event and also add it to the timeline
     * @param event
     */
    private emitEvent(event: TimelineEvent) {
        const ev = {
            ...event,
            timestamp: new Date(),
        };
        // add event to timeline
        this.addToTimeline(ev);

        if (ev.tag) {
            // and emit this event
            this.emit(ev.tag, ev);
        }
    }

    /**
     * Sets the PeerConnection stats reporting interval.
     * @param interval
     *        Interval in milliseconds
     */
    set getStatsInterval(interval: number) {
        if (!Number.isInteger(interval)) {
            throw new Error(`getStatsInterval should be an integer, got: ${interval}`);
        }

        this._getStatsInterval = interval;

        // TODO to be tested
        // Reset restart the interval with new value
        if (this.monitoringSetInterval) {
            this.stopStatsMonitoring();
            this.startStatsMonitoring();
        }
    }

    public get logger() {
        const canLog = (requestLevel: LogLevel) => {
            const allLevels: LogLevel[] = ["none", "error", "warn", "info", "debug"];
            return allLevels.slice(0, allLevels.indexOf(this.logLevel) + 1).indexOf(requestLevel) > -1;
        };
        const self = this;

        return {
            error(...msg: unknown[]) {
                if (self.debug && canLog("error"))
                    console.error(`[webrtc-stats][error] `, ...msg);
            },
            warn(...msg: unknown[]) {
                if (self.debug && canLog("warn"))
                    console.warn(`[webrtc-stats][warn] `, ...msg);
            },
            info(...msg: unknown[]) {
                if (self.debug && canLog("info"))
                    console.log(`[webrtc-stats][info] `, ...msg);
            },
            debug(...msg: unknown[]) {
                if (self.debug && canLog("debug"))
                    console.debug(`[webrtc-stats][debug] `, ...msg);
            },
        };
    }

    public removePeer(id: string) {
        this.logger.info(`Removing PeerConnection with id ${id}.`);
        if (!this.peersToMonitor[id]) return;

        const sendPC = this.peersToMonitor[id].info.sendPC;
        const recvPC = this.peersToMonitor[id].info.recvPC;

        // remove all PeerConnection listeners
        (Object.keys(this.peerConnectionListeners) as Array<keyof PeerListenersMap>).forEach(eventName => {
            const send = this.peerConnectionListeners[id].send[eventName];
            if (send != null) {
                sendPC?.removeEventListener(eventName, send as any);
                delete this.peerConnectionListeners[id].send[eventName];
            }

            const recv = this.peerConnectionListeners[id].recv[eventName];
            if (recv != null) {
                recvPC?.removeEventListener(eventName, recv as any);
                delete this.peerConnectionListeners[id].recv[eventName];
            }
        });

        // remove from peersToMonitor
        delete this.peerConnectionListeners[id];
        delete this.peersToMonitor[id];
    }
}
