import { Effects } from "@crowbartools/firebot-custom-scripts-types/types/effects";
import {
    PLUGIN_ID,
    PLUGIN_NAME
} from "../constants";
import { MeldRemote } from "../meld/meld-remote";

interface FadeSource {
    trackName: string;
    trackId: string;
}

interface FadeEffectModel {
    selectedSources: Array<FadeSource>;
    duration: number;
    curve: FadeCurve;
    finalVolume?: number;
}

function trackSelectTemplate(): string {
    return `
        <eos-container ng-show="missingSources.length > 0">
            <div class="effect-info alert alert-warning">
                <p><b>Warning!</b>
                    Cannot find {{missingSources.length}} sources in this effect. Ensure that Meld Studio is running.
                </p>
            </div>
        </eos-container>

        <setting-container ng-show="missingSources.length > 0" header="Missing Audio Sources ({{missingSources.length}})" collapsed="true">
            <div ng-repeat="tracks in missingSources track by $index">
                <div class="list-item" style="display: flex;border: 2px solid #3e4045;box-shadow: none;border-radius: 8px;padding: 5px 5px;">
                    <div class="pl-5">
                        <span>Audio Track: {{tracks.trackName}}</span>
                    </div>
                    <div>
                        <button class="btn btn-danger" ng-click="deleteSourceAtIndex($index)"><i class="far fa-trash"></i></button>
                    </div>
                </div>
            </div>
        </setting-container>

        <eos-container header="Audio Sources" pad-top="missingSources.length > 0">
            <firebot-input model="searchText" input-title="Filter" disable-variables="true"></firebot-input>
            <div>
                <button class="btn btn-link" ng-click="getTracks()">Refresh Sources</button>
            </div>
            <div ng-if="tracks != null && tracks.length > 0" ng-repeat="track in tracks | filter: {displayName: searchText}">
                <label class="control-fb control--checkbox">{{track.displayName}}
                    <input type="checkbox" ng-click="toggleSourceSelected(track)" ng-checked="sourceIsSelected(track)" aria-label="..." >
                    <div class="control__indicator"></div>
                </label>
            </div>
            <div ng-if="tracks != null && tracks.length < 1" class="muted">
                No tracks found.
            </div>
            <div ng-if="meldConnected === false" class="muted">
                Is Meld Studio running?
            </div>
        </eos-container>
    `;
}

function fadeSettingsTemplate(): string {
    return `
        <eos-container header="Fade" pad-top="true">
            <firebot-input model="effect.duration" input-title="Duration (seconds)" placeholder-text="1"></firebot-input>
            <div style="margin-top: 15px;">
                <div class="btn-group" uib-dropdown>
                    <button id="curve-button" type="button" class="btn btn-default" uib-dropdown-toggle>
                        {{getCurveDisplay()}} <span class="caret"></span>
                    </button>
                    <ul class="dropdown-menu" uib-dropdown-menu role="menu" aria-labelledby="curve-button">
                        <li role="menuitem" ng-click="setCurve('linear')"><a href>Linear</a></li>
                        <li role="menuitem" ng-click="setCurve('ease-in')"><a href>Ease In</a></li>
                        <li role="menuitem" ng-click="setCurve('ease-out')"><a href>Ease Out</a></li>
                    </ul>
                </div>
            </div>
        </eos-container>
    `;
}

function finalVolumeTemplate(): string {
    return `
        <eos-container header="Target Volume" pad-top="true">
            <firebot-input model="effect.finalVolume" input-title="Final Volume (dB)" placeholder-text="0"></firebot-input>
            <p class="muted" style="margin-top: 10px;">
                <b>0 dB</b> is full volume; use a negative value (e.g. <b>-6</b>) for a quieter target.
                To restore a level captured earlier, drop the <b>Original Volume</b> output from a Fade Out effect in here.
            </p>
        </eos-container>
    `;
}

// NOTE: Firebot stringifies this controller and re-evaluates it in its Angular
// frontend, so it MUST be fully self-contained — no closure variables and no
// module-level references. Defaulting finalVolume here is harmless for Fade Out
// (its template never renders the field).
const fadeOptionsController = ($scope: any, backendCommunicator: any) => {
    $scope.meldConnected = false;
    $scope.tracks = null;
    $scope.missingSources = [];

    if ($scope.effect.selectedSources == null) {
        $scope.effect.selectedSources = [];
    }
    if ($scope.effect.duration == null) {
        $scope.effect.duration = 1;
    }
    if ($scope.effect.curve == null) {
        $scope.effect.curve = "linear";
    }
    if ($scope.effect.finalVolume == null) {
        $scope.effect.finalVolume = 0;
    }

    $scope.sourceIsSelected = (track: MeldStudioSessionTrackWithId) => {
        return ($scope.effect.selectedSources ?? []).some(
            (s: FadeSource) => s.trackId === track.id
        );
    };

    $scope.toggleSourceSelected = (track: MeldStudioSessionTrackWithId) => {
        if ($scope.sourceIsSelected(track)) {
            $scope.effect.selectedSources = $scope.effect.selectedSources.filter(
                (s: FadeSource) => !(s.trackId === track.id)
            );
        } else {
            $scope.effect.selectedSources.push({
                trackName: track.name,
                trackId: track.id
            });
            $scope.missingSources = ($scope.missingSources ?? [])
                .filter((s: FadeSource) => s.trackId !== track.id);
        }
    };

    $scope.deleteSourceAtIndex = (index: number) => {
        $scope.effect.selectedSources = $scope.effect.selectedSources.filter(
            (s: FadeSource) => s.trackId !== $scope.missingSources[index].trackId
        );
        $scope.missingSources.splice(index, 1);
    };

    $scope.getStoredData = () => {
        for (const track of $scope.effect.selectedSources) {
            $scope.missingSources.push(track);
        }
    };

    $scope.setCurve = (curve: FadeCurve) => {
        $scope.effect.curve = curve;
    };

    $scope.getCurveDisplay = () => {
        const labels: Record<string, string> = {
            "linear": "Linear",
            "ease-in": "Ease In",
            "ease-out": "Ease Out"
        };
        return labels[$scope.effect.curve] ?? "Linear";
    };

    // Re-bind selections whose track no longer exists (e.g. it was deleted
    // and recreated with a new id). Only heal when exactly one live track
    // matches by name; duplicate names are ambiguous, so those stay flagged
    // as missing for the user to re-pick.
    $scope.reconcileSelectedSources = () => {
        const live: MeldStudioSessionTrackWithId[] = $scope.tracks;
        if (live == null || live.length === 0) {
            return;
        }

        for (const sel of ($scope.effect.selectedSources ?? [])) {
            if (live.some(t => t.id === sel.trackId)) {
                $scope.missingSources = ($scope.missingSources ?? [])
                    .filter((s: FadeSource) => s.trackId !== sel.trackId);
                continue;
            }

            const matches = live.filter(t => t.name === sel.trackName);
            if (matches.length === 1) {
                sel.trackId = matches[0].id;
                $scope.missingSources = ($scope.missingSources ?? [])
                    .filter((s: FadeSource) => s.trackName !== sel.trackName);
            }
        }
    };

    $scope.getTracks = () => {
        $scope.meldConnected = backendCommunicator.fireEventSync("meld:get-connected");
        $scope.tracks = backendCommunicator.fireEventSync("meld:get-track-list") ?? [];

        const layers: MeldStudioSessionLayerWithId[] = backendCommunicator.fireEventSync("meld:get-layer-list");
        const scenes: MeldStudioSessionSceneWithId[] = backendCommunicator.fireEventSync("meld:get-scene-list");

        for (const track of $scope.tracks) {
            if (track.parent) {
                const layer = layers.find(l => l.id === track.parent);
                track.sceneName = scenes.find(s => s.id === track.parent || s.id === layer?.parent)?.name;
            }

            track.displayName = track.sceneName
                ? `${track.name} (Scene: ${track.sceneName})`
                : track.name;
        }

        $scope.reconcileSelectedSources();
    };

    $scope.getTracks();
    $scope.getStoredData();
};

function resolveTrackId(source: FadeSource): string | undefined {
    const track = MeldRemote.getAllTracks().find(
        t => t.id === source.trackId || t.name === source.trackName
    );
    return track?.id;
}

function parseDurationMs(duration: number): number {
    const seconds = Number(duration);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

function roundDb(db: number): number {
    return Math.round(db * 100) / 100;
}

export const FadeTrackVolumeOutEffect: Effects.EffectType<
    FadeEffectModel,
    unknown,
    { originalVolume: number }
> = {
    definition: {
        id: `${PLUGIN_ID}:fade-track-volume-out`,
        name: `${PLUGIN_NAME}: Fade Audio Track Out`,
        description: "Fade an audio track down to silence over a duration",
        icon: "fad fa-volume-down",
        categories: ["common"],
        outputs: [
            {
                label: "Original Volume (dB)",
                description: "The track's volume in dB before the fade out (0 dB = full). Use this as the Final Volume of a later Fade In to restore the previous level. When multiple tracks are selected, this is the first successfully resolved track's value.",
                defaultName: "originalVolume"
            }
        ]
    },
    optionsTemplate: `${trackSelectTemplate()}${fadeSettingsTemplate()}`,
    optionsController: fadeOptionsController,
    onTriggerEvent: async ({ effect, abortSignal }) => {
        const durationMs = parseDurationMs(effect.duration);
        const curve = effect.curve ?? "linear";
        const sources = effect.selectedSources ?? [];

        const originals = await Promise.all(
            sources.map((source) => {
                const trackId = resolveTrackId(source);
                if (trackId == null) {
                    return Promise.resolve<number | null>(null);
                }
                return MeldRemote.fadeTrackOut(trackId, durationMs, curve, abortSignal);
            })
        );

        const firstOriginal = originals.find((v) => v != null) ?? 0;

        return {
            success: true,
            outputs: {
                originalVolume: roundDb(originals[0] ?? firstOriginal)
            }
        };
    }
};

export const FadeTrackVolumeInEffect: Effects.EffectType<FadeEffectModel> = {
    definition: {
        id: `${PLUGIN_ID}:fade-track-volume-in`,
        name: `${PLUGIN_NAME}: Fade Audio Track In`,
        description: "Fade an audio track up to a target volume over a duration",
        icon: "fad fa-volume-up",
        categories: ["common"]
    },
    optionsTemplate: `${trackSelectTemplate()}${finalVolumeTemplate()}${fadeSettingsTemplate()}`,
    optionsController: fadeOptionsController,
    onTriggerEvent: async ({ effect, abortSignal }) => {
        const durationMs = parseDurationMs(effect.duration);
        const curve = effect.curve ?? "linear";
        const targetDb = Number(effect.finalVolume);
        const finalDb = Number.isFinite(targetDb) ? targetDb : 0;
        const sources = effect.selectedSources ?? [];

        await Promise.all(
            sources.map((source) => {
                const trackId = resolveTrackId(source);
                if (trackId == null) {
                    return Promise.resolve(null);
                }
                return MeldRemote.fadeTrackGain(trackId, finalDb, durationMs, curve, abortSignal);
            })
        );

        return true;
    }
};
