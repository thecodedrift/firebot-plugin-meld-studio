import { ScriptModules } from "@crowbartools/firebot-custom-scripts-types";
import ReconnectingWebSocket from "reconnecting-websocket";
import { PluginLogger } from "../plugin-logger";
import { QWebChannel } from "./qwebchannel";
import {
    EVENT_SOURCE_ID,
    CONNECTED_EVENT_ID,
    DISCONNECTED_EVENT_ID,
    STREAMING_STARTED_EVENT_ID,
    STREAMING_STOPPED_EVENT_ID,
    RECORDING_STARTED_EVENT_ID,
    RECORDING_STOPPED_EVENT_ID,
    SCENE_CHANGED_EVENT_ID,
    STAGED_SCENE_CHANGED_EVENT_ID,
    TRACK_MUTED_EVENT_ID,
    TRACK_UNMUTED_EVENT_ID,
    TRACK_VOLUME_CHANGED_EVENT_ID,
    TRACK_MONITORING_CHANGED_EVENT_ID,
} from "../constants";

interface RemoteParams {
    ipAddress: string;
    port: number;
    screenshotDir?: string;
}

// Identifier Meld associates with our track observer registrations.
const OBSERVER_CONTEXT = "firebot-meld-plugin";

// Fades run in dB space (Meld's fader is linear-in-dB); this is the quietest
// point we ramp to before snapping to true silence (amplitude 0).
const FADE_FLOOR_DB = -60;

// How often we push a new gain value during a fade.
const FADE_STEP_MS = 25;

// Meld floods gainUpdated during any change; debounce before surfacing the
// Firebot event so we don't swamp the event queue.
const VOLUME_EVENT_DEBOUNCE_MS = 150;

class MeldRemote {
    private _ipAddress: string = "127.0.0.1";
    private _port: number = 13376;
    private _screenshotDir: string = "";
    private _connected = false;
    private _ws: ReconnectingWebSocket;
    private _webChannel: QWebChannel;
    private _eventManager: ScriptModules["eventManager"];
    private _cachedSessionItems: MeldStudioSessionItemWithId[];
    private _shuttingDown = false;

    // Last-known linear gain (0.0-1.0) per track, seeded at connect from the
    // gainUpdated Meld emits on observer registration.
    private _gainCache = new Map<string, number>();
    // Cancel callbacks for in-flight fades, keyed by track id.
    private _activeFades = new Map<string, () => void>();
    // Tracks currently being faded by us, so we can suppress our own steps
    // from re-triggering the Firebot volume-changed event.
    private _fadingTracks = new Set<string>();
    // Debounce timers for the volume-changed event, keyed by track id.
    private _volumeEventTimers = new Map<string, ReturnType<typeof setTimeout>>();
    // Deferred clears of _fadingTracks. A fade's final setGain calls echo back
    // via gainUpdated asynchronously, after the fade loop has stopped, so we
    // keep suppressing for one debounce window past the end of the fade.
    private _fadeClearTimers = new Map<string, ReturnType<typeof setTimeout>>();

    meld: MeldStudio;

    private buildSessionItemObject(items: Record<string, MeldStudioSessionItem>): MeldStudioSessionItemWithId[] {
        const newItems = Object.entries(items ?? {})
            .map(i => ({
                id: i[0],
                ...i[1]
            }))

        return JSON.parse(JSON.stringify(newItems));
    }

    setupRemote(
        eventManager: ScriptModules["eventManager"],
        { ipAddress, port, screenshotDir }: RemoteParams
    ): void {
        this._eventManager = eventManager;
        this._ipAddress = ipAddress;
        this._port = port;
        this._screenshotDir = screenshotDir ?? "";

        this._ws = new ReconnectingWebSocket(() => `ws://${this._ipAddress}:${this._port}`);

        this._ws.onclose = () => {
            if (this._shuttingDown !== true && this._connected === true) {
                this._connected = false;
                this._eventManager.triggerEvent(
                    EVENT_SOURCE_ID,
                    DISCONNECTED_EVENT_ID,
                    { }
                );
            }
        }
        
        this._ws.onopen = () => {
            this._webChannel = new QWebChannel(this._ws, (channel) => {
                PluginLogger.logDebug("Connected to Meld Studio");
                this.meld = channel.objects.meld;
                this._cachedSessionItems = this.buildSessionItemObject(this.meld.session.items);

                this._gainCache.clear();
                this.setupListeners();
                this.registerTrackObservers();

                this._connected = true;
                this._eventManager.triggerEvent(
                    EVENT_SOURCE_ID,
                    CONNECTED_EVENT_ID,
                    { }
                );
            });
        };
    }

    shutdown(): void {
        this._shuttingDown = true;

        // Cancel any in-flight fades and pending debounced events.
        for (const cancel of this._activeFades.values()) {
            cancel();
        }
        this._activeFades.clear();
        for (const timer of this._fadeClearTimers.values()) {
            clearTimeout(timer);
        }
        this._fadeClearTimers.clear();
        this._fadingTracks.clear();
        for (const timer of this._volumeEventTimers.values()) {
            clearTimeout(timer);
        }
        this._volumeEventTimers.clear();

        this.unregisterTrackObservers();
        this._gainCache.clear();

        this._webChannel = undefined;
        this._ws.close();
        this._ws = undefined;
        this.meld = undefined;
    }

    setupListeners(): void {
        this.meld.sessionChanged.connect(() => {
            PluginLogger.logDebug("Received SessionChanged event from Meld");

            // Build new session object
            const newSessionObject = this.buildSessionItemObject(this.meld.session.items);

            // Observe any tracks that have appeared since the last session update
            // so their gain lands in the cache (registration echoes current gain).
            for (const track of newSessionObject.filter(t => t.type === "track")) {
                if (!this._gainCache.has(track.id)) {
                    this.meld.registerTrackObserver(OBSERVER_CONTEXT, track.id);
                }
            }

            // Check for new active scene
            const newActiveScene = this.getActiveScene();
            const previousActiveScene = this._cachedSessionItems
                .find(i => i.type === "scene" && i.current === true);
            if (newActiveScene.id !== previousActiveScene?.id
            ) {
                this._eventManager.triggerEvent(
                    EVENT_SOURCE_ID,
                    SCENE_CHANGED_EVENT_ID,
                    {
                        scene: newActiveScene
                    }
                )
            }

            // Check for new staged scene
            const newStagedScene = this.getStagedScene();
            const previousStagedScene = this._cachedSessionItems
                .find(i => i.type === "scene" && i.staged === true);

            if ((newStagedScene && !previousStagedScene)
                || (!newStagedScene && previousStagedScene)
                && newStagedScene?.id !== previousStagedScene?.id
            ) {
                this._eventManager.triggerEvent(
                    EVENT_SOURCE_ID,
                    STAGED_SCENE_CHANGED_EVENT_ID,
                    {
                        scene: newStagedScene
                    }
                )
            }

            // Check for track updates
            for (const track of newSessionObject.filter(t => t.type === "track"))
            {
                const existingTrack = this._cachedSessionItems
                    .find(t => t.id === track.id) as MeldStudioSessionTrackWithId;
                
                if (existingTrack) {
                    if (existingTrack.muted !== track.muted) {
                        this._eventManager.triggerEvent(
                            EVENT_SOURCE_ID,
                            track.muted === true ? TRACK_MUTED_EVENT_ID : TRACK_UNMUTED_EVENT_ID,
                            {
                                trackName: track.name,
                                trackId: track.id
                            }
                        );
                    }

                    if (existingTrack.monitoring !== track.monitoring) {
                        this._eventManager.triggerEvent(
                            EVENT_SOURCE_ID,
                            TRACK_MONITORING_CHANGED_EVENT_ID,
                            {
                                trackName: track.name,
                                trackId: track.id,
                                trackMonitoring: track.monitoring
                            }
                        );
                    }
                }
            }

            // Copy session data to the cache
            this._cachedSessionItems = newSessionObject;
        });

        this.meld.isStreamingChanged.connect(() => {
            PluginLogger.logDebug("Received IsStreamingChanged event from Meld");
            this._eventManager.triggerEvent(
                EVENT_SOURCE_ID,
                this.meld.isStreaming === true ? STREAMING_STARTED_EVENT_ID : STREAMING_STOPPED_EVENT_ID,
                { }
            );
        });
        
        this.meld.isRecordingChanged.connect(() => {
            PluginLogger.logDebug("Received IsRecordingChanged event from Meld");
            this._eventManager.triggerEvent(
                EVENT_SOURCE_ID,
                this.meld.isRecording === true ? RECORDING_STARTED_EVENT_ID : RECORDING_STOPPED_EVENT_ID,
                { }
            );
        });

        this.meld.gainUpdated.connect((trackId, gain) => {
            const previousGain = this._gainCache.get(trackId);
            this._gainCache.set(trackId, gain);

            // First value for a track is the seed Meld emits on observer
            // registration, not a user-driven change; cache it silently.
            if (previousGain === undefined) {
                return;
            }

            // Our own fade steps keep the cache fresh but must not spam the
            // Firebot event or re-enter as external changes.
            if (this._fadingTracks.has(trackId)) {
                return;
            }

            this.debounceVolumeChangedEvent(trackId, gain);
        });
    }

    private debounceVolumeChangedEvent(trackId: string, gain: number): void {
        const existing = this._volumeEventTimers.get(trackId);
        if (existing) {
            clearTimeout(existing);
        }

        this._volumeEventTimers.set(trackId, setTimeout(() => {
            this._volumeEventTimers.delete(trackId);
            const track = this.getAllTracks().find(t => t.id === trackId);

            this._eventManager.triggerEvent(
                EVENT_SOURCE_ID,
                TRACK_VOLUME_CHANGED_EVENT_ID,
                {
                    trackName: track?.name,
                    trackId,
                    volume: gain
                }
            );
        }, VOLUME_EVENT_DEBOUNCE_MS));
    }

    private registerTrackObservers(): void {
        for (const track of this.getAllTracks()) {
            this.meld.registerTrackObserver(OBSERVER_CONTEXT, track.id);
        }
    }

    private unregisterTrackObservers(): void {
        for (const trackId of this._gainCache.keys()) {
            try {
                this.meld?.unregisterTrackObserver(OBSERVER_CONTEXT, trackId);
            } catch {
                // Meld may already be gone during shutdown; nothing to do.
            }
        }
    }

    isConnected(): boolean {
        return this._connected;
    }

    updateParams({ ipAddress, port, screenshotDir }: RemoteParams): void {
        this._ipAddress = ipAddress;
        this._port = port;
        this._screenshotDir = screenshotDir ?? "";
    }

    getScreenshotDir(): string {
        return this._screenshotDir;
    }

    // ------------- STREAM ---------------

    startStreaming(): void {
        PluginLogger.logDebug("Starting streaming");
        this.meld.sendCommand("meld.startStreamingAction");
    }

    stopStreaming(): void {
        PluginLogger.logDebug("Stopping streaming");
        this.meld.sendCommand("meld.stopStreamingAction");
    }

    toggleStream(): void {
        PluginLogger.logDebug("Toggling streaming state");
        this.meld.sendCommand("meld.toggleStreamingAction");
    }

    // ------------- RECORD ---------------

    startRecording(): void {
        PluginLogger.logDebug("Starting recording");
        this.meld.sendCommand("meld.startRecordingAction");
    }

    stopRecording(): void {
        PluginLogger.logDebug("Stopping recording");
        this.meld.sendCommand("meld.stopRecordingAction");
    }

    toggleRecord(): void {
        PluginLogger.logDebug("Toggling recording state");
        this.meld.sendCommand("meld.toggleRecordingAction");
    }

    // ------------- SCENES ---------------

    showSceneById(sceneId: string): void {
        PluginLogger.logDebug(`Showing scene with ID ${sceneId}`);
        const scene = this.getAllScenes().find(s => s.id === sceneId);

        if (!scene) {
            PluginLogger.logWarn(`Cannot find scene with ID ${sceneId}`);
            return;
        }

        this.meld.showScene(scene.id);
    }

    showSceneByName(sceneName: string): void {
        PluginLogger.logDebug(`Showing scene ${sceneName}`);
        const scene = this.getAllScenes().find(s => s.name === sceneName);

        if (!scene) {
            PluginLogger.logWarn(`Cannot find scene named ${sceneName}`);
            return;
        }

        this.meld.showScene(scene.id);
    }

    stageSceneById(sceneId: string): void {
        PluginLogger.logDebug(`Staging scene with ID ${sceneId}`);
        const scene = this.getAllScenes().find(s => s.id === sceneId);

        if (!scene) {
            PluginLogger.logWarn(`Cannot find scene with ID ${sceneId}`);
            return;
        }

        this.meld.setStagedScene(scene.id);
    }

    stageSceneByName(sceneName: string): void {
        PluginLogger.logDebug(`Staging scene ${sceneName}`);
        const scene = this.getAllScenes().find(s => s.name === sceneName);

        if (!scene) {
            PluginLogger.logWarn(`Cannot find scene named ${sceneName}`);
            return;
        }

        this.meld.setStagedScene(scene.id);
    }

    showStagedScene(): void {
        PluginLogger.logDebug("Showing staged scene");
        this.meld.showStagedScene();
    }
    
    // ------------- LAYERS ---------------

    toggleLayerVisibility(sceneId: string, layerId: string): void {
        PluginLogger.logDebug(`Toggling visibility for layer ID ${layerId} in scene ID ${sceneId}`);
        this.meld.toggleLayer(sceneId, layerId);
    }

    setLayerVisibility(layerId: string, visible = true): void {
        PluginLogger.logDebug(`${visible === true  ? "Showing" : "Hiding"} layer ID ${layerId}`);
        this.meld.setProperty(layerId, "visible", visible);
    }

    seekMediaLayer(layerId: string, seconds: number): void {
        PluginLogger.logDebug(`Seeking media on layer ID ${layerId} to ${seconds} seconds`);
        this.meld.callFunctionWithArgs(layerId, "seek", [seconds]);
    }

    setBrowserSourceUrlById(layerId: string, url: string): void {
        PluginLogger.logDebug(`Setting URL for browser source ID ${layerId}`);
        const source = this.getBrowserSources().find(l => l.id === layerId);

        if (!source) {
            PluginLogger.logWarn(`Cannot find browser source with ID ${layerId}`);
            return;
        }

        this._setObjectProperty(source.id, "url", url);
    }

    setBrowserSourceUrlByName(layerName: string, url: string): void {
        PluginLogger.logDebug(`Setting URL for browser source ${layerName}`);
        const source = this.getBrowserSources().find(l => l.name === layerName);

        if (!source) {
            PluginLogger.logWarn(`Cannot find browser source named ${layerName}`);
            return;
        }

        this._setObjectProperty(source.id, "url", url);
    }

    setLayerPlaybackById(
        layerId: string,
        action: "play" | "pause",
        layerName?: string,
        sceneName?: string
    ): void {
        PluginLogger.logDebug(`${action === "play" ? "Resuming" : "Pausing"} layer with ID ${layerId}`);
        const layer = this.getAllLayers().find(l => l.id === layerId);

        if (!layer) {
            // A stored id goes stale when the layer is deleted and recreated in
            // Meld. Heal at trigger time by falling back to the name — the
            // editor's reconcile only runs when the effect UI is reopened.
            if (layerName != null) {
                PluginLogger.logWarn(`Cannot find layer with ID ${layerId}; falling back to name ${layerName}`);
                this.setLayerPlaybackByName(layerName, action, sceneName);
                return;
            }
            PluginLogger.logWarn(`Cannot find layer with ID ${layerId}`);
            return;
        }

        this.meld.callFunction(layer.id, action);
    }

    setLayerPlaybackByName(layerName: string, action: "play" | "pause", sceneName?: string): void {
        PluginLogger.logDebug(`${action === "play" ? "Resuming" : "Pausing"} layer ${layerName}${sceneName ? ` in scene ${sceneName}` : ""}`);
        const matches = this.getAllLayers().filter(l => l.name === layerName);

        // Disambiguate same-named layers by scene when we have one; a layer's
        // parent is its scene id.
        let layer = matches[0];
        if (sceneName != null && matches.length > 1) {
            const scene = this.getAllScenes().find(s => s.name === sceneName);
            layer = matches.find(l => l.parent === scene?.id) ?? matches[0];
        }

        if (!layer) {
            PluginLogger.logWarn(`Cannot find layer named ${layerName}`);
            return;
        }

        this.meld.callFunction(layer.id, action);
    }

    // ------------- AUDIO TRACKS ---------------

    private _setTrackMute(
        track: MeldStudioSessionTrackWithId,
        mute: boolean | "toggle"
    ): void {
        if (mute === "toggle") {
            this.meld.toggleMute(track.id);
        } else {
            this.meld.setMuted(track.id, mute);
        }
    }

    setTrackMuteById(trackId: string, mute: boolean | "toggle" = true): void {
        PluginLogger.logDebug(`${mute === "toggle"
            ? "Toggling mute for"
            : (mute === true ? "Muting" : "Unmuting")} track with ID ${trackId}`);
        const track = this.getAllTracks().find(s => s.id === trackId);

        if (!track) {
            PluginLogger.logWarn(`Cannot find track with ID ${trackId}`);
            return;
        }

        this._setTrackMute(track, mute);
    }

    setTrackMuteByName(trackName: string, mute: boolean | "toggle" = true): void {
        PluginLogger.logDebug(`${mute === "toggle"
            ? "Toggling mute for"
            : (mute === true ? "Muting" : "Unmuting")} track ${trackName}`);
        const track = this.getAllTracks().find(s => s.name === trackName);

        if (!track) {
            PluginLogger.logWarn(`Cannot find track named ${trackName}`);
            return;
        }

        this._setTrackMute(track, mute);
    }

    private _setTrackMonitor(
        track: MeldStudioSessionTrackWithId,
        monitor: boolean | "toggle"
    ): void {
        if (monitor === "toggle") {
            this.meld.toggleMonitor(track.id);
        } else {
            this._setObjectProperty(track.id, "monitoring", monitor);
        }
    }

    setTrackMonitoringById(trackId: string, monitor: boolean | "toggle"): void {
        PluginLogger.logDebug(`${monitor === "toggle"
            ? "Toggling"
            : (monitor === true ? "Enabling" : "Disabling")} monitoring on track with ID ${trackId}`);
        const track = this.getAllTracks().find(s => s.id === trackId);

        if (!track) {
            PluginLogger.logWarn(`Cannot find track with ID ${trackId}`);
            return;
        }

        this._setTrackMonitor(track, monitor);
    }

    setTrackMonitoringByName(trackName: string, monitor: boolean | "toggle"): void {
        PluginLogger.logDebug(`${monitor === "toggle"
            ? "Toggling"
            : (monitor === true ? "Enabling" : "Disabling")} monitoring on track ${trackName}`);
        const track = this.getAllTracks().find(s => s.name === trackName);

        if (!track) {
            PluginLogger.logWarn(`Cannot find track named ${trackName}`);
            return;
        }

        this._setTrackMonitor(track, monitor);
    }

    // ------------- EFFECTS ---------------

    private _setEffectEnabled(
        effect: MeldStudioSessionEffectWithId,
        enabled: boolean | "toggle"
    ): void {
        if (enabled === "toggle") {
            const layer = this.getAllLayers().find(l => l.id === effect.parent);
            const sceneId = layer?.parent;

            if (!layer || !sceneId) {
                PluginLogger.logWarn(`Cannot resolve scene/layer for effect ID ${effect.id}`);
                return;
            }

            this.meld.toggleEffect(sceneId, layer.id, effect.id);
        } else {
            this._setObjectProperty(effect.id, "enabled", enabled);
        }
    }

    setEffectEnabledById(effectId: string, enabled: boolean | "toggle"): void {
        PluginLogger.logDebug(`${enabled === "toggle"
            ? "Toggling"
            : (enabled === true ? "Enabling" : "Disabling")} effect with ID ${effectId}`);
        const effect = this.getAllEffects().find(e => e.id === effectId);

        if (!effect) {
            PluginLogger.logWarn(`Cannot find effect with ID ${effectId}`);
            return;
        }

        this._setEffectEnabled(effect, enabled);
    }

    setEffectEnabledByName(effectName: string, enabled: boolean | "toggle"): void {
        PluginLogger.logDebug(`${enabled === "toggle"
            ? "Toggling"
            : (enabled === true ? "Enabling" : "Disabling")} effect ${effectName}`);
        const effect = this.getAllEffects().find(e => e.name === effectName);

        if (!effect) {
            PluginLogger.logWarn(`Cannot find effect named ${effectName}`);
            return;
        }

        this._setEffectEnabled(effect, enabled);
    }

    // ------------- AUDIO FADES ---------------

    private _ampToDb(amp: number): number {
        if (amp <= 0) {
            return FADE_FLOOR_DB;
        }
        const db = 20 * Math.log10(amp);
        return db < FADE_FLOOR_DB ? FADE_FLOOR_DB : db;
    }

    private _dbToAmp(db: number): number {
        if (db <= FADE_FLOOR_DB) {
            return 0;
        }
        const amp = Math.pow(10, db / 20);
        return amp > 1 ? 1 : amp;
    }

    private _ease(curve: FadeCurve, t: number): number {
        switch (curve) {
            // Slow start, quick finish.
            case "ease-in":
                return t * t;
            // Quick start, gentle finish.
            case "ease-out":
                return 1 - (1 - t) * (1 - t);
            case "linear":
            default:
                return t;
        }
    }

    /**
     * Returns a track's current volume in dB (0 dB = unity), or `undefined`
     * if we have never observed a value for it. Silence reads as the fade
     * floor.
     */
    getTrackGainDb(trackId: string): number | undefined {
        const amp = this._gainCache.get(trackId);
        return amp === undefined ? undefined : this._ampToDb(amp);
    }

    /**
     * Ramps a track's gain from its current value to `targetDb` over
     * `durationMs`, stepping in dB space so the fade sounds even. Resolves with
     * the track's original volume in dB (its level before the fade started).
     * Any fade already running on the track is cancelled first.
     */
    fadeTrackGain(
        trackId: string,
        targetDb: number,
        durationMs: number,
        curve: FadeCurve,
        signal?: AbortSignal
    ): Promise<number> {
        // Cancel a fade already in flight on this track so they don't fight.
        this._activeFades.get(trackId)?.();
        // A previous fade may have left a pending suppression-clear; cancel it
        // so this new fade isn't un-suppressed partway through.
        const pendingClear = this._fadeClearTimers.get(trackId);
        if (pendingClear) {
            clearTimeout(pendingClear);
            this._fadeClearTimers.delete(trackId);
        }

        const currentAmp = this._gainCache.get(trackId) ?? 1;
        const fromDb = this._ampToDb(currentAmp);
        const toDb = targetDb;

        // Jump straight to the target for a zero/negative duration.
        if (durationMs <= 0 || fromDb === toDb) {
            this._fadingTracks.add(trackId);
            const amp = this._dbToAmp(toDb);
            this.meld.setGain(trackId, amp);
            this._gainCache.set(trackId, amp);
            this.scheduleFadingClear(trackId);
            return Promise.resolve(fromDb);
        }

        return new Promise<number>((resolve) => {
            this._fadingTracks.add(trackId);
            const startTime = Date.now();

            const finish = () => {
                clearInterval(timer);
                signal?.removeEventListener("abort", finish);
                this._activeFades.delete(trackId);
                // Keep suppressing briefly: the final setGain echoes back later.
                this.scheduleFadingClear(trackId);
                resolve(fromDb);
            };

            // Register cancellation hooks (new fade on this track, abort, shutdown).
            this._activeFades.set(trackId, finish);
            signal?.addEventListener("abort", finish, { once: true });

            const timer = setInterval(() => {
                const elapsed = Date.now() - startTime;
                let t = elapsed / durationMs;
                if (t >= 1) {
                    t = 1;
                }

                const db = fromDb + (toDb - fromDb) * this._ease(curve, t);
                const amp = this._dbToAmp(db);
                this.meld.setGain(trackId, amp);
                this._gainCache.set(trackId, amp);

                if (t >= 1) {
                    finish();
                }
            }, FADE_STEP_MS);
        });
    }

    // Clear a track's fade-suppression flag one debounce window after the fade
    // stops, so the trailing gainUpdated echoes of our own final setGain calls
    // don't surface as user-driven volume-changed events.
    private scheduleFadingClear(trackId: string): void {
        const existing = this._fadeClearTimers.get(trackId);
        if (existing) {
            clearTimeout(existing);
        }
        this._fadeClearTimers.set(trackId, setTimeout(() => {
            this._fadeClearTimers.delete(trackId);
            this._fadingTracks.delete(trackId);
        }, VOLUME_EVENT_DEBOUNCE_MS));
    }

    /**
     * Fades a track down to silence. Resolves with its original volume in dB
     * so it can be restored later.
     */
    fadeTrackOut(
        trackId: string,
        durationMs: number,
        curve: FadeCurve,
        signal?: AbortSignal
    ): Promise<number> {
        return this.fadeTrackGain(trackId, FADE_FLOOR_DB, durationMs, curve, signal);
    }

    // ------------- MISC ACTIONS ---------------

    takeScreenshot(vertical = false): void {
        if (vertical === true && this.getAllScenes().some(s => s.vertical === true)) {
            PluginLogger.logDebug("Taking vertical screenshot");
            this.meld.sendCommand("meld.screenshot.vertical");
        } else {
            PluginLogger.logDebug("Taking screenshot");
            this.meld.sendCommand("meld.screenshot");
        }
    }

    recordClip(): void {
        PluginLogger.logDebug("Recording clip");
        this.meld.sendCommand("meld.recordClip");
    }

    toggleVirtualCamera(): void {
        PluginLogger.logDebug("Toggling virtual camera");
        this.meld.sendCommand("meld.toggleVirtualCameraAction");
    }

    showReplay(): void {
        PluginLogger.logDebug("Showing replay");
        this.meld.sendCommand("meld.replay.show");
    }

    dismissReplay(): void {
        PluginLogger.logDebug("Dismissing replay");
        this.meld.sendCommand("meld.replay.dismiss");
    }

    private _setObjectProperty(objectId: string, propertyName: string, value: any): void {
        PluginLogger.logDebug(`Setting object ${objectId} property ${propertyName} to ${value}`);
        this.meld.setProperty(objectId, propertyName, value);
    }

    // ------------- GETTERS ---------------

    private _getSessionItems(type?: MeldStudioSessionItemType): MeldStudioSessionItemWithId[] {
        const items = Object.entries(this.meld?.session?.items ?? {})
            .map((item) => ({
                id: item[0],
                ...item[1]
            }));

        if (type != null) {
            return items.filter(i => i.type === type);
        }

        return items;
    }

    getAllScenes(): MeldStudioSessionSceneWithId[] {
        return this._getSessionItems("scene") as MeldStudioSessionSceneWithId[];
    }

    getActiveScene(): MeldStudioSessionSceneWithId {
        return this.getAllScenes().find(s => s.current === true);
    }

    getStagedScene(): MeldStudioSessionSceneWithId {
        return this.getAllScenes().find(s => s.staged === true);
    }

    getScenesWithLayers(): MeldStudioSceneWithLayers[] {
        const scenes = this.getAllScenes() as MeldStudioSceneWithLayers[];

        for (const scene of scenes) {
            scene.layers = this.getLayersForScene(scene.id);
        }

        return scenes;
    }

    getAllLayers(): MeldStudioSessionLayerWithId[] {
        return this._getSessionItems("layer") as MeldStudioSessionLayerWithId[];
    }

    getLayersForScene(sceneId: string): MeldStudioSessionLayerWithId[] {
        return this.getAllLayers().filter(l => l.parent === sceneId);
    }

    getImageSources(): MeldStudioSessionItemWithId[] {
        return this.getAllLayers().filter(l => l.source != null);
    }

    getMediaSources(): MeldStudioSessionItemWithId[] {
        return this.getAllLayers().filter(l => l.mediaSource != null);
    }

    getBrowserSources(): MeldStudioSessionItemWithId[] {
        return this.getAllLayers().filter(l => l.url != null);
    }

    getAllTracks(): MeldStudioSessionTrackWithId[] {
        return this._getSessionItems("track") as MeldStudioSessionTrackWithId[];
    }

    getAllEffects(): MeldStudioSessionEffectWithId[] {
        return this._getSessionItems("effect") as MeldStudioSessionEffectWithId[];
    }
}

const meldRemote = new MeldRemote();

export { meldRemote as MeldRemote };