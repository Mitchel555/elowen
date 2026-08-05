/** What a turn should do about the vision-fallback model, decided BEFORE any session is touched.
 *  Pure — the caller (BrainService.send, inside its user-level lock) performs the stop/start. */
export type VisionHop =
  /** Stay on the current session. */
  | { action: 'none' }
  /** Image turn with a configured, different vision model → respawn on it. */
  | { action: 'hop'; provider?: string; model: string }
  /** Text-only turn while parked on the fallback → respawn back on the user's normal model. */
  | { action: 'hop-back' };

export function decideVisionHop(i: {
  hasImages: boolean;
  /** Whether the session currently runs on the vision-fallback model. */
  onFallback: boolean;
  /** The model the CURRENT session runs on — so we never hop onto the model we're already on. */
  currentModel?: string;
  /** Config provider entry of the current session. The same model id can exist under multiple
   *  providers, so provider identity participates whenever the fallback explicitly names one. */
  currentProvider?: string;
  /** Whether the catalog KNOWS the current model reads images. True → no hop: the fallback exists for
   *  models that cannot do this, and sending the turn elsewhere would answer with a weaker model than
   *  the one the user chose. False/undefined keeps the previous behaviour, so an unprobeable relay still
   *  gets the safety net rather than an opaque provider 400. */
  currentModelHasVision?: boolean;
  visionModel?: string;
  visionModelProvider?: string;
}): VisionHop {
  // Route an image turn to the operator's configured vision model when one is set, its provider/model
  // pair differs from the current session, AND the current model is not already known to read images.
  // That last condition is the point of the fallback: it is a safety net for a text-only model, not a
  // redirect away from a capable one — hopping off a vision-capable model answers the user on something
  // they did not pick, and throws away the conversation's warm cache to do it.
  const providerDiffers = !!i.visionModelProvider && i.visionModelProvider !== i.currentProvider;
  if (i.hasImages && i.visionModel && !i.currentModelHasVision
      && (i.visionModel !== i.currentModel || providerDiffers)) {
    return { action: 'hop', provider: i.visionModelProvider || undefined, model: i.visionModel };
  }
  if (!i.hasImages && i.onFallback) return { action: 'hop-back' };
  return { action: 'none' };
}
