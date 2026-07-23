import { Effects } from "@crowbartools/firebot-custom-scripts-types/types/effects";
import {
    PLUGIN_ID,
    PLUGIN_NAME
} from "../constants";
import { MeldRemote } from "../meld/meld-remote";

type SourceAction = boolean | "toggle";

type LayerWithScene = MeldStudioSessionLayerWithId & {
    scene: MeldStudioSessionSceneWithId
}

type SelectedLayer = {
    sceneId: string;
    sceneName: string;
    layerId: string;
    layerName: string;
    action: SourceAction;
}

// A live layer as it currently exists in Meld (a SelectedLayer without the
// stored action), used when reconciling stale selections back to live layers.
type LiveLayer = Omit<SelectedLayer, "action">;

export const ToggleLayerVisibilityEffect: Effects.EffectType<{
    selectedLayers: Array<SelectedLayer>;
}> = {
    definition: {
        id: `${PLUGIN_ID}:toggle-layer-visibility`,
        name: `${PLUGIN_NAME}: Toggle Layer Visibility`,
        description: "Toggle a layer's visibility in Meld Studio",
        icon: "fad fa-layer-group",
        categories: ["common"]
    },
    optionsTemplate: `
        <eos-container ng-show="missingLayers.length > 0">
            <div class="effect-info alert alert-warning">
                <p><b>Warning!</b> 
                    Cannot find {{missingLayers.length}} layers in this effect. Ensure Meld Studio is running.
                </p>
            </div>
        </eos-container>

        <setting-container ng-show="missingLayers.length > 0" header="Missing Layers ({{missingLayers.length}})" collapsed="true">
            <div ng-repeat="layer in missingLayers track by $index">
                <div class="list-item" style="display: flex;border: 2px solid #3e4045;box-shadow: none;border-radius: 8px;padding: 5px 5px;">
                    <div class="pl-5">
                        <span>Scene: {{layer.sceneName}},</span>
                        <span>Name: {{layer.layerName || 'Unknown'}},</span>
                        <span ng-if="layer.layerName == null">Id: {{layer.layerId}},</span>
                        <span>Action: {{getMissingActionDisplay(layer.action)}}</span>
                    </div>   
                    <div>
                        <button class="btn btn-danger" ng-click="deleteLayerAtIndex($index)"><i class="far fa-trash"></i></button>
                    </div>
                </div>
            </div>
        </setting-container>

        <eos-container header="Layers" pad-top="missingLayers.length > 0">
            <div class="effect-setting-container">
                <div class="input-group">
                  <span class="input-group-addon">Filter</span>
                  <input type="text" class="form-control" ng-change="filterScenes(searchText)" ng-model="searchText" placeholder="Enter your search term here..." aria-describeby="meld-studio-visibility-search-box">
                </div>
            </div>

            <div>
                <button class="btn btn-link" ng-click="loadLayers()">Refresh Layer Data</button>
            </div>

            <div class="effect-setting-container setting-padtop">
                <div ng-if="scenes != null" ng-repeat="scene in filteredScenes">
                    <div style="font-size: 16px;font-weight: 900;color: #b9b9b9;margin-bottom: 5px;">{{scene.name}}</div>
                    <div ng-repeat="layer in getLayers(scene.id) | filter: {name: searchText}">
                        <label class="control-fb control--checkbox">{{layer.displayName || layer.name}}
                            <input type="checkbox" ng-click="toggleLayerSelected(scene.id, scene.name, layer.id, layer.name)" ng-checked="layerIsSelected(scene.id, layer.id)" aria-label="...">
                            <div class="control__indicator"></div>
                        </label>
                        <div ng-show="layerIsSelected(scene.id, layer.id)" style="margin-bottom: 15px;">
                            <div class="btn-group" uib-dropdown>
                                <button id="single-button" type="button" class="btn btn-default" uib-dropdown-toggle>
                                    {{getLayerActionDisplay(scene.id, layer.id)}} <span class="caret"></span>
                                </button>
                                <ul class="dropdown-menu" uib-dropdown-menu role="menu" aria-labelledby="single-button">
                                    <li role="menuitem" ng-click="setLayerAction(scene.id, layer.id, true)"><a href>Show</a></li>
                                    <li role="menuitem" ng-click="setLayerAction(scene.id, layer.id, false)"><a href>Hide</a></li>
                                    <li role="menuitem" ng-click="setLayerAction(scene.id, layer.id, 'toggle')"><a href>Toggle</a></li>
                                </ul>
                            </div>
                        </div>
                    </div>
                </div>

                <div ng-if="meldConnected !== true" class="muted">
                    Meld Studio is not connected.
                </div>
            </div>
        </eos-container>
    `,
    optionsController: ($scope: any, backendCommunicator: any) => {
        $scope.meldConnected = false;
        $scope.scenes = [];
        $scope.filteredScenes = [];
        $scope.missingLayers = [];
        
        if ($scope.effect.selectedLayers == null) {
            $scope.effect.selectedLayers = [];
        }
        
        $scope.getLayers = (sceneId: string) => {
            return $scope.scenes
                ? $scope.scenes.find((s: any) => s.id === sceneId)?.layers ?? []
                : [];
        };

        $scope.getScenes = (): MeldStudioSessionSceneWithId[] => {
            return $scope.scenes ?? [];
        };

        $scope.getScene = (sceneId: string): MeldStudioSessionSceneWithId => {
            return $scope.scenes
                .find((s: MeldStudioSessionSceneWithId) => s.id === sceneId);
        }

        $scope.filterScenes = (filter = "") => {
            $scope.filteredScenes = [];
            if ($scope.scenes == null) {
                return;
            }

            for (const scene of $scope.getScenes()) {
                if ($scope.getLayers(scene.id)
                        .filter((s: LayerWithScene) => s.name.toLowerCase().includes(filter.toLowerCase())).length > 0) {
                    $scope.filteredScenes.push(scene);
                }
            }
        };

        $scope.layerIsSelected = (sceneId: string, layerId: string) => {
            return ($scope.effect.selectedLayers ?? []).some(
                (s: SelectedLayer) => s.sceneId === sceneId && s.layerId === layerId
            );
        };

        $scope.toggleLayerSelected = (sceneId: string, sceneName: string, layerId: string, layerName: string) => {
            if ($scope.layerIsSelected(sceneId, layerId)) {
                $scope.effect.selectedLayers = $scope.effect.selectedLayers.filter(
                    (s: SelectedLayer) => !(s.sceneId === sceneId && s.layerId === layerId)
                );
            } else {
                $scope.effect.selectedLayers.push({
                    sceneId,
                    sceneName,
                    layerId,
                    layerName,
                    action: true
                });
            }
        };

        $scope.setLayerAction = (
            sceneId: string,
            layerId: string,
            action: SourceAction
        ) => {
            const selectedLayer = $scope.effect.selectedLayers.find(
                (s: SelectedLayer) => s.sceneId === sceneId && s.layerId === layerId
            );
            if (selectedLayer != null) {
                selectedLayer.action = action;
            }
        };
        
        $scope.getLayerActionDisplay = (sceneId: string, layerId: string) => {
            const selectedLayer = ($scope.effect.selectedLayers ?? []).find(
                (s: SelectedLayer) => s.sceneId === sceneId && s.layerId === layerId
            );

            if (selectedLayer == null) {
                return "";
            }

            $scope.missingLayers = ($scope.missingLayers ?? [])
                .filter((i: SelectedLayer) => i !== selectedLayer);

            if (selectedLayer.action === "toggle") {
                return "Toggle";
            }
            if (selectedLayer.action === true) {
                return "Show";
            }
            return "Hide";
        };

        $scope.getMissingActionDisplay = (selectedFilter?: SourceAction) => {
            if (selectedFilter == null) {
                return "";
            }
            if (selectedFilter === "toggle") {
                return "Toggle";
            }
            if (selectedFilter === true) {
                return "Show";
            }
            return "Hide";
        };

        $scope.deleteLayerAtIndex = (index: number) => {
            $scope.effect.selectedLayers = $scope.effect.selectedLayers.filter(
                (i: SelectedLayer) => i !== $scope.missingLayers[index]
            );
            $scope.missingLayers.splice(index, 1);
        };

        $scope.loadStoredData = () => {
            for (const layer of $scope.effect.selectedLayers) {
                $scope.missingLayers.push(layer);
            }
        };

        // Re-bind selections whose layer no longer exists (e.g. it was deleted
        // and recreated, which gives it a new id). Only heal when exactly one
        // live layer matches by name/scene; duplicate names are ambiguous, so
        // those are left flagged as missing for the user to re-pick rather than
        // silently binding to the wrong layer.
        $scope.reconcileSelectedLayers = () => {
            if ($scope.scenes == null || $scope.scenes.length === 0) {
                return;
            }

            const live: LiveLayer[] = [];
            for (const scene of $scope.scenes) {
                for (const layer of (scene.layers ?? [])) {
                    live.push({
                        sceneId: scene.id,
                        sceneName: scene.name,
                        layerId: layer.id,
                        layerName: layer.name
                    });
                }
            }

            // Track which live layers are already bound so healing never points
            // two stale selections at the same physical layer. Seed with the
            // selections that still resolve to a live layer by id.
            const claimed = new Set<string>();
            for (const sel of ($scope.effect.selectedLayers ?? [])) {
                if (live.some(l => l.sceneId === sel.sceneId && l.layerId === sel.layerId)) {
                    claimed.add(`${sel.sceneId}:${sel.layerId}`);
                }
            }

            for (const sel of ($scope.effect.selectedLayers ?? [])) {
                if (live.some(l => l.sceneId === sel.sceneId && l.layerId === sel.layerId)) {
                    continue;
                }
                if (sel.layerName == null) {
                    continue;
                }

                let match: LiveLayer | null = null;
                const contextMatches = live.filter(l =>
                    l.layerName === sel.layerName && l.sceneName === sel.sceneName
                );

                if (contextMatches.length === 1) {
                    match = contextMatches[0];
                } else {
                    const nameMatches = live.filter(l => l.layerName === sel.layerName);
                    if (nameMatches.length === 1) {
                        match = nameMatches[0];
                    }
                }

                if (match != null) {
                    const key = `${match.sceneId}:${match.layerId}`;
                    // Another selection already owns this live layer; binding
                    // this one too would leave two rows pointing at the same
                    // physical layer. Leave it flagged as missing instead.
                    if (claimed.has(key)) {
                        continue;
                    }
                    claimed.add(key);
                    sel.sceneId = match.sceneId;
                    sel.sceneName = match.sceneName;
                    sel.layerId = match.layerId;
                }
            }
        };

        $scope.loadLayers = () => {
            $scope.meldConnected = backendCommunicator.fireEventSync("meld:get-connected");
            $scope.scenes = backendCommunicator.fireEventSync("meld:get-scene-list-with-layers") ?? [];

            // Disambiguate layers that share a name within a scene so duplicates
            // can be told apart in the list.
            for (const scene of $scope.scenes) {
                const layers = scene.layers ?? [];
                const nameCounts: Record<string, number> = {};
                for (const layer of layers) {
                    nameCounts[layer.name] = (nameCounts[layer.name] ?? 0) + 1;
                }
                for (const layer of layers) {
                    layer.displayName = nameCounts[layer.name] > 1
                        ? `${layer.name} (Layer #${layer.index + 1})`
                        : layer.name;
                }
            }

            $scope.reconcileSelectedLayers();
            $scope.filterScenes();
        };

        $scope.loadLayers();
        $scope.loadStoredData();
    },
    onTriggerEvent: async ({ effect }) => {
        if (!effect.selectedLayers?.length) {
            return;
        }

        for (const layer of effect.selectedLayers) {
            if (layer.action === "toggle") {
                MeldRemote.toggleLayerVisibility(layer.sceneId, layer.layerId);
            } else {
                MeldRemote.setLayerVisibility(layer.layerId, layer.action);
            }
        }

        return true;
    }
}