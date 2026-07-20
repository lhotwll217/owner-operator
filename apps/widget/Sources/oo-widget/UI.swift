// The widget's SwiftUI content, hosted inside the floating panel. Collapsed = a small always-on
// bar (status dot · counts · the loudest needs-you leaf). Expanded in place = the full session state,
// grouped by repo, loudest-first. Nothing here computes state — it renders the daemon's snapshot.

import SwiftUI

/// The whole widget: the compact bar, plus the expanded list when opened. The floating panel
/// auto-sizes to this view, so toggling `expanded` resizes the HUD.
struct WidgetRoot: View {
    @EnvironmentObject var client: DaemonClient
    @State private var expanded = false

    var body: some View {
        VStack(spacing: 0) {
            CompactBar(expanded: $expanded)
            if expanded {
                Divider()
                if !client.online {
                    offline
                } else if client.setupRequired {
                    setupRequired
                } else if client.groups.isEmpty {
                    Text("no active threads")
                        .foregroundStyle(.secondary).font(.system(size: 11)).padding(12)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(client.groups) { group in
                                GroupView(group: group, onDone: { id in
                                    withAnimation(.easeInOut(duration: 0.28)) { client.markDone(id) }
                                }, onRename: { id, title in
                                    client.rename(id, to: title)
                                })
                                .transition(.move(edge: .top).combined(with: .opacity))
                            }
                        }
                        .padding(.horizontal, 12).padding(.vertical, 10)
                    }
                    .frame(maxHeight: 360)
                }
                Divider()
                footer
            }
        }
        .frame(width: 300)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.white.opacity(0.08)))
        .contextMenu {
            Button(expanded ? "Collapse" : "Expand") { expanded.toggle() }
            Divider()
            Button("Quit oo-widget") { NSApp.terminate(nil) }
        }
    }

    private var offline: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Daemon offline").font(.system(size: 12, weight: .medium))
            Text("start it with  oo daemon").foregroundStyle(.secondary).font(.system(size: 11))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
    }

    private var setupRequired: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Setup required").font(.system(size: 12, weight: .medium))
            Text("run  oo  in a terminal").foregroundStyle(.secondary).font(.system(size: 11))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
    }

    private var footer: some View {
        HStack {
            Spacer()
            Button("Quit") { NSApp.terminate(nil) }
                .buttonStyle(.borderless).font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
    }
}

/// The always-visible small component: the state counts and (collapsed) the loudest needs-you
/// title — the one "what to do next" leaf. The chevron toggles the expansion; the rest of the bar
/// stays draggable so the panel can be repositioned.
struct CompactBar: View {
    @EnvironmentObject var client: DaemonClient
    @Binding var expanded: Bool

    var body: some View {
        HStack(spacing: 8) {
            if client.online && client.setupRequired {
                Text("setup required").font(.system(size: 11)).foregroundStyle(.yellow)
                Spacer(minLength: 6)
            } else if client.online {
                CountsRow(counts: client.counts)
                if !expanded && !fresh.isEmpty {
                    FreshTicker(items: fresh)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else if !expanded, let top = topNeedsYou {
                    lineText(top).font(.system(size: 11)).lineLimit(1)
                    Spacer(minLength: 6)
                } else {
                    Spacer(minLength: 6)
                }
            } else {
                Text("daemon offline").font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer(minLength: 6)
            }
            Button { expanded.toggle() } label: {
                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    .font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .contentShape(Rectangle())
    }

    /// Surface the loudest needs-you row, including a delegated child nested below its parent.
    private var topNeedsYou: SessionStateRow? {
        client.groups.lazy.flatMap(\.rows).first { $0.state == .needsYou }
    }

    /// Threads whose turn finished in the last 5 min — what the soft pulse cycles through.
    private var fresh: [SessionStateRow] { client.freshNeedsYou() }
}

/// One thread as `mark Project → next step`: the tool's logo (when bundled), the project
/// tinted light blue, an arrow (the session state's `→ next step` pattern), then the next step in
/// full. `Text` (not AttributedString) so the mark rides inline. Shared by the calm line and
/// the ticker.
private let projectBlue = Color(red: 0.40, green: 0.76, blue: 1.0)

private func lineText(_ r: SessionStateRow) -> Text {
    var proj = AttributeContainer(); proj.foregroundColor = projectBlue
    var out = AttributedString(r.repo, attributes: proj)
    var arrow = AttributeContainer(); arrow.foregroundColor = .secondary
    out.append(AttributedString("  →  ", attributes: arrow))
    var step = AttributeContainer(); step.foregroundColor = .primary
    out.append(AttributedString(r.nextSteps ?? r.title, attributes: step))
    guard let mark = AppBadge.textMark(for: r.app) else { return Text(out) }
    return mark + Text(" ") + Text(out)
}

/// All fresh items joined into one ticker line, separated by a dim dot.
private func tickerText(_ rows: [SessionStateRow]) -> Text {
    var out = Text(verbatim: "")
    for (i, r) in rows.enumerated() {
        if i > 0 {
            var sep = AttributeContainer(); sep.foregroundColor = .secondary
            out = out + Text(AttributedString("    ·    ", attributes: sep))
        }
        out = out + lineText(r)
    }
    return out
}

/// A slow looping ticker: sit at the beginning for 10s, then scroll the whole line slowly through —
/// the end wraps into the beginning seamlessly (two copies; when the first scrolls off, the second
/// sits exactly where the first started, so resetting to 0 is invisible) — then sit again. Only
/// animates during the scroll; fully idle while sitting. `gen` cancels stale timers if data changes.
struct FreshTicker: View {
    let items: [SessionStateRow]

    @State private var offset: CGFloat = 0
    @State private var textWidth: CGFloat = 0
    @State private var containerWidth: CGFloat = 0
    @State private var gen = 0
    @State private var timer: Timer?

    private let gap: CGFloat = 56     // blank between the loop's end and its repeat
    private let speed: Double = 26    // points/sec — slow
    private let sitSeconds: Double = 10

    var body: some View {
        GeometryReader { geo in
            HStack(spacing: gap) {
                tickerText(items).font(.system(size: 11)).lineLimit(1).fixedSize()
                    .background(GeometryReader { g in
                        Color.clear.preference(key: TickerTextWidthKey.self, value: g.size.width)
                    })
                tickerText(items).font(.system(size: 11)).lineLimit(1).fixedSize()
            }
            .offset(x: offset)
            .frame(width: geo.size.width, height: 15, alignment: .leading)
            .clipped()
            .onAppear { containerWidth = geo.size.width; restart() }
            .onChange(of: geo.size.width) { containerWidth = $0; restart() }
        }
        .frame(height: 15)
        .onPreferenceChange(TickerTextWidthKey.self) { textWidth = $0; restart() }
        .onDisappear { timer?.invalidate(); timer = nil }
    }

    private func restart() {
        timer?.invalidate()
        gen += 1
        offset = 0
        sit(gen)
    }

    /// Hold at the beginning, then scroll once through.
    private func sit(_ g: Int) {
        timer = Timer.scheduledTimer(withTimeInterval: sitSeconds, repeats: false) { _ in
            if g == gen { scrollThrough(g) }
        }
    }

    private func scrollThrough(_ g: Int) {
        guard textWidth > containerWidth else { sit(g); return } // it all fits → just keep sitting
        let distance = Double(textWidth + gap)
        let dur = distance / speed
        withAnimation(.linear(duration: dur)) { offset = -CGFloat(distance) }
        DispatchQueue.main.asyncAfter(deadline: .now() + dur) {
            guard g == gen else { return }
            offset = 0 // invisible: the 2nd copy is already here — end == beginning
            sit(g)
        }
    }
}

private struct TickerTextWidthKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// The stats line: nonzero state counts, colored (◐ needs-you · ● working · ○ idle). Done is
/// omitted — once it's done it's done; the glance is for what still wants attention.
struct CountsRow: View {
    let counts: [ThreadState: Int]
    private let order: [ThreadState] = [.needsYou, .working, .idle]

    var body: some View {
        HStack(spacing: 8) {
            ForEach(order, id: \.self) { st in
                if let n = counts[st], n > 0 {
                    Text("\(st.glyph) \(n)").foregroundStyle(st.color).font(.system(size: 11))
                }
            }
        }
    }
}

struct GroupView: View {
    let group: RepoGroup
    let onDone: (String) -> Void
    let onRename: (String, String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Text("▾ \(group.repo)").font(.system(size: 12, weight: .semibold)).foregroundStyle(.cyan)
                Text("\(group.rows.count)").foregroundStyle(.secondary).font(.system(size: 11))
            }
            ForEach(group.rows) { row in
                RowView(row: row, onDone: { onDone(row.id) }, onRename: { onRename(row.id, $0) })
                    .padding(.leading, CGFloat(row.nestingDepth * 18))
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
    }
}

/// One thread: glyph · P-badge · title (wraps, never truncates) · recency · a done check, then the
/// grey next-step, then origin (±diff · app). Keep every word.
/// Rename via the pencil that appears on hover (or double-click the title) — your title is
/// preferred over the AI's (which keeps titling underneath); submit it empty (or use the
/// context menu) to show AI titles again. STABILITY RULE: hover/edit state may only swap
/// what's drawn inside space that is always reserved — never insert or remove layout — so
/// text never re-wraps and neighbors never move.
struct RowView: View {
    let row: SessionStateRow
    let onDone: () -> Void
    let onRename: (String) -> Void
    @State private var hovering = false
    @State private var rowHovering = false
    @State private var editing = false
    @State private var draft = ""
    @FocusState private var titleFocused: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Text(row.state.glyph)
                .foregroundStyle(row.state.color).font(.system(size: 12))
                .frame(width: 12, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    if let p = row.priority {
                        Text("P\(p)").foregroundStyle(priorityColor(p)).font(.system(size: 10, weight: .bold))
                    }
                    title
                    titleAffordance
                    Spacer(minLength: 6)
                    Text(shortAge(row.lastActive)).foregroundStyle(.secondary).font(.system(size: 10))
                    doneCheck
                }
                if let next = row.nextSteps, !next.isEmpty {
                    Text("→ \(next)")
                        .foregroundStyle(.secondary).font(.system(size: 11))
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 6) {
                    if row.diffAdded != nil || row.diffDeleted != nil {
                        Text("+\(row.diffAdded ?? 0)").foregroundStyle(.green).font(.system(size: 10))
                        Text("-\(row.diffDeleted ?? 0)").foregroundStyle(.red).font(.system(size: 10))
                    }
                    Spacer()
                    AppBadge(app: row.app)
                }
            }
        }
        .onHover { rowHovering = $0 }
        .contextMenu {
            Button("Rename…") { startEditing() }
            if row.isRenamed {
                Button("Use AI title") { onRename("") }
            }
        }
    }

    /// The title, or its inline editor while renaming. The editor wraps exactly like the
    /// title text (no reflow on entry) and carries a quiet fill so edit mode reads as a mode.
    /// Return commits, Escape cancels.
    @ViewBuilder private var title: some View {
        if editing {
            TextField("title", text: $draft, axis: .vertical)
                .textFieldStyle(.plain).font(.system(size: 12))
                .fixedSize(horizontal: false, vertical: true)
                .background(RoundedRectangle(cornerRadius: 3).fill(Color.primary.opacity(0.08)).padding(-2))
                .focused($titleFocused)
                .onSubmit { editing = false; commit() }
                .onExitCommand { editing = false }
        } else {
            Text(row.title).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
                .onTapGesture(count: 2) { startEditing() }
        }
    }

    /// One FIXED slot beside the title — pencil on row hover, an explicit commit check while
    /// editing, invisible otherwise. It always occupies its frame so the title's wrap width
    /// never changes across idle/hover/edit (HIG edit-in-place stability; WCAG 3.2.1/3.2.2 —
    /// no layout change on focus or input).
    private var titleAffordance: some View {
        Group {
            if editing {
                Button(action: { editing = false; commit() }) {
                    Image(systemName: "checkmark.circle.fill").font(.system(size: 11)).foregroundStyle(.green)
                }
                .buttonStyle(.plain)
                .help("Save title (Return commits, Escape cancels)")
            } else {
                Button(action: startEditing) {
                    Image(systemName: "pencil").font(.system(size: 10)).foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .opacity(rowHovering ? 1 : 0)
                .help("Rename — your title shows instead of the AI's until you clear it")
            }
        }
        .frame(width: 12, alignment: .leading)
    }

    private func startEditing() {
        draft = row.title
        editing = true
        titleFocused = true
    }

    private func commit() {
        let t = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        // Empty clears the rename (AI titles resume); an unchanged title is a no-op.
        if t != row.title { onRename(t) }
    }

    /// Mark-done affordance: a quiet grey check that lights green on hover; click resolves the
    /// thread (the row then collapses away). Read-only stays honest — it just sets owner state.
    private var doneCheck: some View {
        Button(action: onDone) {
            Image(systemName: hovering ? "checkmark.circle.fill" : "checkmark.circle")
                .font(.system(size: 12))
                .foregroundStyle(hovering ? Color.green : Color.secondary)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help("Mark done")
    }
}

/// The origin line's app tag: the tool's real logo (a background-free mark rendered from the
/// brand SVG, bundled in Resources/), app name on hover — every app in the canonical
/// vocabulary (see detectUi in the scan skill) has one. Claude and Codex marks cover all
/// their variants (CLI / App / SDK). Monochrome marks render as templates so they tint to the
/// current foreground in light and dark; color marks (Claude's terracotta, Antigravity's
/// arch, PostHog's hedgehog) keep their brand colors. An unrecognized app falls back to the
/// plain text tag.
struct AppBadge: View {
    let app: String

    /// resource name + whether it's a monochrome template mark (tinted) vs a full-color mark.
    private static let logos: [(prefix: String, resource: String, template: Bool)] = [
        ("Claude", "claude", false),
        ("Codex", "codex", true),
        ("Conductor", "conductor", true),
        ("Cursor", "cursor", true),
        ("Superset", "superset", true),
        ("PostHog", "posthog", false),
        ("Antigravity", "antigravity", false),
        ("Grok", "grok", true),
        ("opencode", "opencode", true),
        ("pi", "pi", true),
    ]
    private static var cache: [String: (image: NSImage, template: Bool)] = [:]

    /// The tool's mark, point-sized to ride beside 11pt text (the hi-res rep keeps it crisp
    /// on retina). Shared by the badge and the inline `Text` uses (calm line, ticker).
    static func mark(for app: String) -> (image: NSImage, template: Bool)? {
        guard let hit = logos.first(where: { app.hasPrefix($0.prefix) }) else { return nil }
        if let m = cache[hit.resource] { return m }
        guard let img = Bundle.module.image(forResource: hit.resource) else { return nil }
        img.size = NSSize(width: 11, height: 11)
        let m = (img, hit.template)
        cache[hit.resource] = m
        return m
    }

    /// The mark as a `Text`-inline image, nudged down to sit optically centered on the line.
    static func textMark(for app: String) -> Text? {
        guard let m = mark(for: app) else { return nil }
        return Text(Image(nsImage: m.image).renderingMode(m.template ? .template : .original))
            .foregroundColor(.secondary) // tints template marks; full-color marks ignore it
            .baselineOffset(-2)
    }

    @State private var hovering = false

    var body: some View {
        // The mark alone carries the tag; hovering reveals the name as an OVERLAY floating to
        // the mark's left (inline .help() tooltips don't show reliably in a nonactivating
        // panel). An overlay takes no layout space, so hovering moves nothing — the mark and
        // every neighbor stay put.
        if let m = Self.mark(for: app) {
            Image(nsImage: m.image)
                .renderingMode(m.template ? .template : .original)
                .resizable().interpolation(.high).scaledToFit()
                .frame(width: 11, height: 11)
                .foregroundStyle(.secondary) // tints template marks; full-color marks ignore it
                .onHover { hovering = $0 }
                .overlay(alignment: .trailing) {
                    if hovering {
                        Text(app).foregroundStyle(.secondary).font(.system(size: 10))
                            .padding(.horizontal, 4).padding(.vertical, 1)
                            .background(RoundedRectangle(cornerRadius: 3).fill(.background))
                            .fixedSize()
                            .offset(x: -14) // float just left of the mark
                            .allowsHitTesting(false)
                    }
                }
        } else {
            Text(app).foregroundStyle(.tertiary).font(.system(size: 10))
        }
    }
}
