import { ReplaceVariable } from "@crowbartools/firebot-custom-scripts-types/types/modules/replace-variable-manager";
import { VARIABLE_PREFIX } from "../constants";
import { MeldRemote } from "../meld/meld-remote";

export const TrackVolumeDbVariable: ReplaceVariable = {
    definition: {
        handle: `${VARIABLE_PREFIX}TrackVolumeDb`,
        description: "The current volume of an audio track in Meld Studio, in dB (0 dB = full volume). Pass a track name or id, or use it inside a Track Volume Changed event for that track.",
        usage: "meldTrackVolumeDb[trackNameOrId]",
        examples: [
            {
                usage: "meldTrackVolumeDb",
                description: "The current volume (dB) of the track from the triggering event."
            },
            {
                usage: "meldTrackVolumeDb[Music]",
                description: "The current volume (dB) of the track named \"Music\"."
            }
        ],
        possibleDataOutput: [ "number" ]
    },
    evaluator: async (trigger, trackNameOrId?: string) => {
        let trackId: string | undefined;

        const arg = trackNameOrId != null ? `${trackNameOrId}`.trim() : "";
        if (arg.length > 0) {
            const track = MeldRemote.getAllTracks().find(
                t => t.id === arg || t.name === arg
            );
            trackId = track?.id;
        } else {
            trackId = trigger?.metadata?.eventData?.trackId as string | undefined;
        }

        if (trackId == null) {
            return null;
        }

        const db = MeldRemote.getTrackGainDb(trackId);
        return db == null ? null : Math.round(db * 100) / 100;
    }
};
