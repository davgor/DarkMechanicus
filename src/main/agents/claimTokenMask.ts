/**
 * The claim-token masker lives in core, where progress notes need it too (core never imports from
 * `src/main`); the hosted-agent modules keep importing it from here.
 */
export {
  CLAIM_TOKEN_MASK,
  createStreamMasker,
  maskClaimTokens,
  maskClaimTokensDeep,
  type StreamMasker
} from '../../core/claimTokenMask'
