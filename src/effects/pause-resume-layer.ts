import { Effects } from "@crowbartools/firebot-custom-scripts-types/types/effects";
import {
    PLUGIN_ID,
    PLUGIN_NAME
} from "../constants";
import { MeldRemote } from "../meld/meld-remote";

type PlaybackAction = "play" | "pause";

interface LayerSource {
    layerName: string;
    layerId: string;
    sceneName?: string;
    action: PlaybackAction;
}

type DisplayLayer = MeldStudioSessionLayerWithId & {
    displayName?: string;
    sceneName?: string;
};

export const PauseResumeLayerEffect: Effects.EffectType<{
    selectedSources: Array<LayerSource>
}> = {
    definition: {
        id: `${PLUGIN_ID}:pause-resume-layer`,
        name: `${PLUGIN_NAME}: Pause/Resume Media`,
        description: "Pause or resume a media (video/audio file) layer in Meld Studio",
        icon: "fad fa-pause",
        categories: ["common"]
    },
    optionsTemplate: `
        <eos-container ng-show="missingSources.length > 0">
            <div class="effect-info alert alert-warning">
                <p><b>Warning!</b>
                    Cannot find {{missingSources.length}} layers in this effect. Ensure that Meld Studio is running.
                </p>
            </div>
        </eos-container>

        <setting-container ng-show="missingSources.length > 0" header="Missing Layers ({{missingSources.length}})" collapsed="true">
            <div ng-repeat="layers in missingSources track by $index">
                <div class="list-item" style="display: flex;border: 2px solid #3e4045;box-shadow: none;border-radius: 8px;padding: 5px 5px;">
                    <div class="pl-5">
                        <span>Layer: {{layers.layerName}}</span><span ng-if="layers.sceneName"> (Scene: {{layers.sceneName}})</span>
                    </div>
                    <div>
                        <button class="btn btn-danger" ng-click="deleteSourceAtIndex($index)"><i class="far fa-trash"></i></button>
                    </div>
                </div>
            </div>
        </setting-container>

        <eos-container header="Media Layers" pad-top="missingSources.length > 0">
            <firebot-input model="searchText" input-title="Filter" disable-variables="true"></firebot-input>
            <div>
                <button class="btn btn-link" ng-click="getLayers()">Refresh Media Layers</button>
            </div>
            <div ng-if="layers != null && layers.length > 0" ng-repeat="layer in layers | filter: {displayName: searchText}">
                <label class="control-fb control--checkbox">{{layer.displayName}}
                    <input type="checkbox" ng-click="toggleSourceSelected(layer)" ng-checked="sourceIsSelected(layer)"  aria-label="..." >
                    <div class="control__indicator"></div>
                </label>
                <div ng-show="sourceIsSelected(layer)" style="margin-bottom: 15px;">
                    <div class="btn-group" uib-dropdown>
                        <button id="single-button" type="button" class="btn btn-default" uib-dropdown-toggle>
                            {{getSourceActionDisplay(layer)}} <span class="caret"></span>
                        </button>
                        <ul class="dropdown-menu" uib-dropdown-menu role="menu" aria-labelledby="single-button">
                            <li role="menuitem" ng-click="setSourceAction(layer, 'play')"><a href>Resume</a></li>
                            <li role="menuitem" ng-click="setSourceAction(layer, 'pause')"><a href>Pause</a></li>
                        </ul>
                    </div>
                </div>
            </div>
            <div ng-if="layers != null && layers.length < 1" class="muted">
                No media layers found.
            </div>
            <div ng-if="meldConnected === false" class="muted">
                Is Meld Studio running?
            </div>
        </eos-container>
    `,
    optionsController: ($scope: any, backendCommunicator: any) => {
        $scope.meldConnected = false;
        $scope.layers = null;
        $scope.missingSources = [];

        if ($scope.effect.selectedSources == null) {
            $scope.effect.selectedSources = [];
        }

        $scope.sourceIsSelected = (layer: DisplayLayer) => {
            return ($scope.effect.selectedSources ?? []).some(
                (s: LayerSource) => s.layerId === layer.id
            );
        };

        $scope.toggleSourceSelected = (layer: DisplayLayer) => {
            if ($scope.sourceIsSelected(layer)) {
                $scope.effect.selectedSources = $scope.effect.selectedSources.filter(
                    (s: LayerSource) => !(s.layerId === layer.id)
                );
            } else {
                $scope.effect.selectedSources.push({
                    layerName: layer.name,
                    layerId: layer.id,
                    sceneName: layer.sceneName,
                    action: "pause"
                });
            }
        };

        $scope.setSourceAction = (
            layer: DisplayLayer,
            action: PlaybackAction
        ) => {
            const selectedSource = $scope.effect.selectedSources.find(
                (s: LayerSource) => s.layerId === layer.id
            );
            if (selectedSource != null) {
                selectedSource.action = action;
            }
        };

        $scope.getSourceActionDisplay = (layer: DisplayLayer) => {
            const selectedSource = ($scope.effect.selectedSources ?? []).find(
                (s: LayerSource) => s.layerId === layer.id
            );

            if (selectedSource == null) {
                return "";
            }

            $scope.missingSources = ($scope.missingSources ?? [])
                .filter((i: LayerSource) => i.layerId !== selectedSource.layerId);

            return selectedSource.action === "play" ? "Resume" : "Pause";
        };

        $scope.deleteSourceAtIndex = (index: number) => {
            $scope.effect.selectedSources = $scope.effect.selectedSources.filter(
                (s: LayerSource) => s.layerId !== $scope.missingSources[index].layerId
            );
            $scope.missingSources.splice(index, 1);
        };

        $scope.getStoredData = () => {
            for (const layer of $scope.effect.selectedSources) {
                $scope.missingSources.push(layer);
            }
        };

        // Re-bind selections whose layer no longer exists (e.g. it was deleted
        // and recreated, which gives it a new id). Only heal when exactly one
        // live layer matches by name/scene; duplicate names are ambiguous, so
        // those are left flagged as missing for the user to re-pick.
        $scope.reconcileSelectedSources = () => {
            const live: DisplayLayer[] = $scope.layers;
            if (live == null || live.length === 0) {
                return;
            }

            for (const sel of ($scope.effect.selectedSources ?? [])) {
                if (live.some((l: DisplayLayer) => l.id === sel.layerId)) {
                    continue;
                }

                let match: DisplayLayer | null = null;
                const contextMatches = live.filter((l: DisplayLayer) =>
                    l.name === sel.layerName && l.sceneName === sel.sceneName
                );

                if (contextMatches.length === 1) {
                    match = contextMatches[0];
                } else {
                    const nameMatches = live.filter((l: DisplayLayer) => l.name === sel.layerName);
                    if (nameMatches.length === 1) {
                        match = nameMatches[0];
                    }
                }

                if (match != null) {
                    sel.layerId = match.id;
                    sel.sceneName = match.sceneName;
                }
            }
        };

        $scope.getLayers = () => {
            $scope.meldConnected = backendCommunicator.fireEventSync("meld:get-connected");
            $scope.layers = backendCommunicator.fireEventSync("meld:get-media-layers") ?? [];

            const scenes: MeldStudioSessionSceneWithId[] = backendCommunicator.fireEventSync("meld:get-scene-list");

            // Count names within a scene so same-named layers can be told apart.
            const nameCounts: Record<string, number> = {};
            for (const layer of $scope.layers) {
                layer.sceneName = scenes.find(s => s.id === layer.parent)?.name;
                const key = `${layer.parent}::${layer.name}`;
                nameCounts[key] = (nameCounts[key] ?? 0) + 1;
            }

            for (const layer of $scope.layers) {
                const duplicated = nameCounts[`${layer.parent}::${layer.name}`] > 1;
                const suffix = duplicated ? `, Layer #${layer.index + 1}` : "";
                layer.displayName = layer.sceneName
                    ? `${layer.name} (Scene: ${layer.sceneName}${suffix})`
                    : `${layer.name}${duplicated ? ` (Layer #${layer.index + 1})` : ""}`;
            }

            $scope.reconcileSelectedSources();
        };

        $scope.getLayers();
        $scope.getStoredData();
    },
    onTriggerEvent: async ({ effect }) => {
        if (effect.selectedSources == null || effect.selectedSources.length === 0) {
            return true;
        }

        for (const { layerId, layerName, sceneName, action } of effect.selectedSources) {
            if (layerId) {
                MeldRemote.setLayerPlaybackById(layerId, action, layerName, sceneName);
            } else {
                MeldRemote.setLayerPlaybackByName(layerName, action, sceneName);
            }
        }
        return true;
    }
}
