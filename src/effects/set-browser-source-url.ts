import { Effects } from "@crowbartools/firebot-custom-scripts-types/types/effects";
import {
    PLUGIN_ID,
    PLUGIN_NAME
} from "../constants";
import { MeldRemote } from "../meld/meld-remote";

export const SetBrowserSourceUrlEffect: Effects.EffectType<{
    sourceName: string,
    sourceId: string,
    url: string
}> = {
    definition: {
        id: `${PLUGIN_ID}:set-browser-source-url`,
        name: `${PLUGIN_NAME}: Set Browser Source URL`,
        description: "Sets the URL of a browser source in Meld Studio, loading the new page",
        icon: "fad fa-browser",
        categories: ["common"]
    },
    optionsTemplate: `
        <eos-container header="Meld Studio Browser Source">
            <div>
                <button class="btn btn-link" ng-click="getBrowserSources()">Refresh Browser Sources</button>
            </div>
            <ui-select ng-if="meldConnected === true" ng-model="selected" on-select="selectSource($select.selected)">
                <ui-select-match placeholder="Select a browser source...">{{$select.selected.displayName}}</ui-select-match>
                <ui-select-choices repeat="source in browserSources | filter: {displayName: $select.search}">
                    <div ng-bind-html="source.displayName | highlight: $select.search"></div>
                </ui-select-choices>
                <ui-select-no-choice>
                    <b>No browser sources found.</b>
                </ui-select-no-choice>
            </ui-select>

            <div ng-if="meldConnected !== true" class="muted">
                Meld Studio is not connected.
            </div>
        </eos-container>

        <eos-container header="URL" pad-top="true">
            <firebot-input model="effect.url" input-title="URL" placeholder-text="Enter a URL..."></firebot-input>
        </eos-container>
    `,
    optionsController: ($scope: any, backendCommunicator: any) => {
        $scope.meldConnected = false;
        $scope.browserSources = [];

        $scope.selectSource = (source: MeldStudioSessionLayerWithId & { displayName?: string }) => {
            $scope.effect.sourceName = source.name;
            $scope.effect.sourceId = source.id;
        };

        $scope.getBrowserSources = () => {
            $scope.meldConnected = backendCommunicator.fireEventSync("meld:get-connected");
            $scope.browserSources = backendCommunicator.fireEventSync("meld:get-browser-layers");

            const scenes: MeldStudioSessionSceneWithId[] = backendCommunicator.fireEventSync("meld:get-scene-list");

            for (const source of $scope.browserSources) {
                const sceneName = scenes.find(s => s.id === source.parent)?.name;
                source.displayName = sceneName
                    ? `${source.name} (Scene: ${sceneName})`
                    : source.name;
            }

            let selected = $scope.browserSources.find((s: MeldStudioSessionLayerWithId) =>
                s.id === $scope.effect.sourceId
            );

            if (selected == null) {
                selected = $scope.browserSources.find((s: MeldStudioSessionLayerWithId) =>
                    s.name === $scope.effect.sourceName
                );
            }

            $scope.selected = selected;
        };

        $scope.getBrowserSources();
    },
    optionsValidator: (effect) => {
        const errors = [];
        if (effect.sourceId == null && effect.sourceName == null) {
            errors.push("Please select a browser source.");
        }
        if (effect.url == null || effect.url === "") {
            errors.push("Please enter a URL.");
        }
        return errors;
    },
    getDefaultLabel: (effect) => {
        return effect.sourceName;
    },
    onTriggerEvent: async (event) => {
        if (event.effect.sourceId) {
            MeldRemote.setBrowserSourceUrlById(event.effect.sourceId, event.effect.url);
        } else {
            MeldRemote.setBrowserSourceUrlByName(event.effect.sourceName, event.effect.url);
        }
        return true;
    }
}
