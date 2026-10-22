/** A presentation fact projected from an existing, confirmed native receipt.
 * No prompt/answer body and no authority to submit or restart execution. */
export type AcceptedPresentationInput = {
  id: string;
  hostId: string;
  threadId: string;
  turnId: string;
  kind: "answer" | "steer";
  acceptedAt: number;
  origin?: import("./turn-audience.js").TurnParticipantOrigin;
};
