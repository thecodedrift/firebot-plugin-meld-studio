import { Effects } from "@crowbartools/firebot-custom-scripts-types/types/effects";
import {
    PLUGIN_ID,
    PLUGIN_NAME
} from "../constants";
import { MeldRemote } from "../meld/meld-remote";

interface EffectSource {
    effectName: string;
    effectId: string;
    layerName?: string;
    sceneName?: string;
    action: boolean | "toggle";
}

type DisplayEffect = MeldStudioSessionEffectWithId & {
    displayName?: string;
    layerName?: string;
    sceneName?: string;
};

export const ToggleEffectEffect: Effects.EffectType<{
    selectedSources: Array<EffectSource>
}> = {
    definition: {
        id: `${PLUGIN_ID}:toggle-effect`,
        name: `${PLUGIN_NAME}: Toggle Effect`,
        description: "Enable, disable, or toggle effects on layers in Meld Studio",
        icon: "fad fa-magic",
        categories: ["common"]
    },
    optionsTemplate: `
        <eos-container ng-show="missingSources.length > 0">
            <div class="effect-info alert alert-warning">
                <p><b>Warning!</b>
                    Cannot find {{missingSources.length}} effects in this effect. Ensure that Meld Studio is running.
                </p>
            </div>
        </eos-container>

        <setting-container ng-show="missingSources.length > 0" header="Missing Effects ({{missingSources.length}})" collapsed="true">
            <div ng-repeat="effects in missingSources track by $index">
                <div class="list-item" style="display: flex;border: 2px solid #3e4045;box-shadow: none;border-radius: 8px;padding: 5px 5px;">
                    <div class="pl-5">
                        <span>Effect: {{effects.effectName}}</span><span ng-if="effects.layerName"> (Layer: {{effects.layerName}}<span ng-if="effects.sceneName">, Scene: {{effects.sceneName}}</span>)</span>
                    </div>
                    <div>
                        <button class="btn btn-danger" ng-click="deleteSourceAtIndex($index)"><i class="far fa-trash"></i></button>
                    </div>
                </div>
            </div>
        </setting-container>

        <eos-container header="Effects" pad-top="missingSources.length > 0">
            <firebot-input model="searchText" input-title="Filter" disable-variables="true"></firebot-input>
            <div>
                <button class="btn btn-link" ng-click="getEffects()">Refresh Effects</button>
            </div>
            <div ng-if="effects != null && effects.length > 0" ng-repeat="fx in effects | filter: {displayName: searchText}">
                <label class="control-fb control--checkbox">{{fx.displayName}}
                    <input type="checkbox" ng-click="toggleSourceSelected(fx)" ng-checked="sourceIsSelected(fx)"  aria-label="..." >
                    <div class="control__indicator"></div>
                </label>
                <div ng-show="sourceIsSelected(fx)" style="margin-bottom: 15px;">
                    <div class="btn-group" uib-dropdown>
                        <button id="single-button" type="button" class="btn btn-default" uib-dropdown-toggle>
                            {{getSourceActionDisplay(fx)}} <span class="caret"></span>
                        </button>
                        <ul class="dropdown-menu" uib-dropdown-menu role="menu" aria-labelledby="single-button">
                            <li role="menuitem" ng-click="setSourceAction(fx, true)"><a href>Enable</a></li>
                            <li role="menuitem" ng-click="setSourceAction(fx, false)"><a href>Disable</a></li>
                            <li role="menuitem" ng-click="setSourceAction(fx, 'toggle')"><a href>Toggle</a></li>
                        </ul>
                    </div>
                </div>
            </div>
            <div ng-if="effects != null && effects.length < 1" class="muted">
                No effects found.
            </div>
            <div ng-if="meldConnected === false" class="muted">
                Is Meld Studio running?
            </div>
        </eos-container>
    `,
    optionsController: ($scope: any, backendCommunicator: any) => {
        $scope.meldConnected = false;
        $scope.effects = null;
        $scope.missingSources = [];

        if ($scope.effect.selectedSources == null) {
            $scope.effect.selectedSources = [];
        }

        $scope.sourceIsSelected = (fx: MeldStudioSessionEffectWithId) => {
            return ($scope.effect.selectedSources ?? []).some(
                (s: EffectSource) => s.effectId === fx.id
            );
        };

        $scope.toggleSourceSelected = (fx: DisplayEffect) => {
            if ($scope.sourceIsSelected(fx)) {
                $scope.effect.selectedSources = $scope.effect.selectedSources.filter(
                    (s: EffectSource) => !(s.effectId === fx.id)
                );
            } else {
                $scope.effect.selectedSources.push({
                    effectName: fx.name,
                    effectId: fx.id,
                    layerName: fx.layerName,
                    sceneName: fx.sceneName,
                    action: true
                });
            }
        };

        $scope.setSourceAction = (
            fx: MeldStudioSessionEffectWithId,
            action: boolean | "toggle"
        ) => {
            const selectedSource = $scope.effect.selectedSources.find(
                (s: EffectSource) => s.effectId === fx.id
            );
            if (selectedSource != null) {
                selectedSource.action = action;
            }
        };

        $scope.getSourceActionDisplay = (fx: MeldStudioSessionEffectWithId) => {
            const selectedSource = ($scope.effect.selectedSources ?? []).find(
                (s: EffectSource) => s.effectId === fx.id
            );

            if (selectedSource == null) {
                return "";
            }

            $scope.missingSources = ($scope.missingSources ?? [])
                .filter((i: EffectSource) => i.effectId !== selectedSource.effectId);

            if (selectedSource.action === "toggle") {
                return "Toggle";
            }
            if (selectedSource.action === true) {
                return "Enable";
            }
            return "Disable";
        };

        $scope.deleteSourceAtIndex = (index: number) => {
            $scope.effect.selectedSources = $scope.effect.selectedSources.filter(
                (s: EffectSource) => s.effectId !== $scope.missingSources[index].effectId
            );
            $scope.missingSources.splice(index, 1);
        };

        $scope.getStoredData = () => {
            for (const fx of $scope.effect.selectedSources) {
                $scope.missingSources.push(fx);
            }
        };

        // Re-bind selections whose effect no longer exists (e.g. it was deleted
        // and recreated, which gives it a new id). Only heal when exactly one
        // live effect matches by name/context; duplicate names are ambiguous, so
        // those are left flagged as missing for the user to re-pick rather than
        // silently binding to the wrong effect.
        $scope.reconcileSelectedSources = () => {
            const live: DisplayEffect[] = $scope.effects;
            if (live == null || live.length === 0) {
                return;
            }

            for (const sel of ($scope.effect.selectedSources ?? [])) {
                if (live.some((e: DisplayEffect) => e.id === sel.effectId)) {
                    continue;
                }

                let match: DisplayEffect | null = null;
                const contextMatches = live.filter((e: DisplayEffect) =>
                    e.name === sel.effectName
                    && e.layerName === sel.layerName
                    && e.sceneName === sel.sceneName
                );

                if (contextMatches.length === 1) {
                    match = contextMatches[0];
                } else {
                    const nameMatches = live.filter((e: DisplayEffect) => e.name === sel.effectName);
                    if (nameMatches.length === 1) {
                        match = nameMatches[0];
                    }
                }

                if (match != null) {
                    sel.effectId = match.id;
                    sel.layerName = match.layerName;
                    sel.sceneName = match.sceneName;
                }
            }
        };

        $scope.getEffects = () => {
            $scope.meldConnected = backendCommunicator.fireEventSync("meld:get-connected");
            $scope.effects = backendCommunicator.fireEventSync("meld:get-effect-list") ?? [];

            const layers: MeldStudioSessionLayerWithId[] = backendCommunicator.fireEventSync("meld:get-layer-list");
            const scenes: MeldStudioSessionSceneWithId[] = backendCommunicator.fireEventSync("meld:get-scene-list");

            for (const fx of $scope.effects) {
                const layer = layers.find(l => l.id === fx.parent);
                fx.layerName = layer?.name;
                fx.sceneName = scenes.find(s => s.id === layer?.parent)?.name;

                if (fx.layerName && fx.sceneName) {
                    fx.displayName = `${fx.name} (Layer: ${fx.layerName}, Scene: ${fx.sceneName})`;
                } else if (fx.layerName) {
                    fx.displayName = `${fx.name} (Layer: ${fx.layerName})`;
                } else {
                    fx.displayName = fx.name;
                }
            }

            $scope.reconcileSelectedSources();
        };

        $scope.getEffects();
        $scope.getStoredData();
    },
    onTriggerEvent: async ({ effect }) => {
        if (effect.selectedSources == null) {
            return true;
        }

        for (const { effectId, effectName, action } of effect.selectedSources) {
            if (effectId) {
                MeldRemote.setEffectEnabledById(effectId, action);
            } else {
                MeldRemote.setEffectEnabledByName(effectName, action);
            }
        }
        return true;
    }
}
