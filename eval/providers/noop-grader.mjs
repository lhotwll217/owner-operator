// Behavioral cases are graded deterministically from trajectory + state metadata. Promptfoo
// still resolves a test's grading provider eagerly, so this inert provider keeps those cases
// independent of the retrieval suite's LLM rubric provider.
export default class NoopGraderProvider {
  id() { return "owner-operator-behavioral-deterministic-grader"; }
  async callApi() {
    throw new Error("the deterministic behavioral profile must not invoke an LLM grader");
  }
}
