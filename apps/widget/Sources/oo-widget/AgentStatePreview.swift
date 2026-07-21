#if DEBUG
import SwiftUI

/// Reviewable widget-specific interaction mock, shown beside the approved terminal timeline rail.
struct AgentStateInteractionPreview: PreviewProvider {
    static var previews: some View {
        Group {
            AgentStateInteractionMock(expanded: false)
                .previewDisplayName("Agent state rail")
            AgentStateInteractionMock(expanded: true)
                .previewDisplayName("Attention-first detail")
        }
    }
}

private struct AgentStateInteractionMock: View {
    @State private var expanded: Bool

    init(expanded: Bool) {
        _expanded = State(initialValue: expanded)
    }

    var body: some View {
        VStack(spacing: 0) {
            AgentStateRail(footer: mockAgentState.footer ?? "") {
                withAnimation(.easeInOut(duration: 0.2)) { expanded = true }
            }
            if expanded {
                Divider()
                AgentStateSection(view: mockAgentState)
                    .padding(10)
            }
        }
        .frame(width: 300)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}

private let mockAgentState = AgentStateView(
    counts: AgentStateCounts(queued: 1, running: 1, attention: 1),
    footer: "Agent state: 1 queued · 1 running · 1 needs attention",
    runs: [
        AgentRunView(
            id: "failed",
            harness: "codex",
            task: "Investigate startup compatibility",
            status: AgentRunStatusView(glyph: "!", text: .failed),
            category: .attention,
            elapsedMs: 3_000,
            latestActivity: "ACP handshake failed",
            canCancel: false,
            canResume: true
        ),
        AgentRunView(
            id: "running",
            harness: "claude-code",
            task: "Compare widget and terminal behavior",
            status: AgentRunStatusView(glyph: "●", text: .running),
            category: .active,
            elapsedMs: 252_000,
            latestActivity: "Reviewing the timeline rail",
            canCancel: true,
            canResume: false
        ),
        AgentRunView(
            id: "queued",
            harness: "codex",
            task: "Review the implementation",
            status: AgentRunStatusView(glyph: "◦", text: .queued),
            category: .active,
            elapsedMs: 18_000,
            latestActivity: "",
            canCancel: true,
            canResume: false
        ),
        AgentRunView(
            id: "completed",
            harness: "codex",
            task: "Map the Gateway seam",
            status: AgentRunStatusView(glyph: "✓", text: .completed),
            category: .recent,
            elapsedMs: 221_000,
            latestActivity: "Done",
            canCancel: false,
            canResume: false
        ),
    ]
)
#endif
