// The widget's SwiftUI content, hosted inside the floating panel. Collapsed = a small always-on
// bar (needs-you and working counts · the fresh needs-you ticker). Expanded in place = the
// session state in the daemon's sections and order. Nothing here computes state or order — it
// renders the daemon's snapshot.

import SwiftUI

/// The whole widget: the compact bar, plus the expanded list when opened. The floating panel
/// auto-sizes to this view, so toggling `expanded` resizes the HUD.
struct WidgetRoot: View {
    @EnvironmentObject var client: DaemonClient
    @State private var expanded = false
    @State private var snoozedOpen = false

    private var listMaxHeight: CGFloat { (NSScreen.main?.visibleFrame.height ?? 900) * 0.7 }

    var body: some View {
        VStack(spacing: 0) {
            CompactBar(expanded: $expanded)
            if expanded {
                Divider()
                if !client.online {
                    offline
                } else if client.setupRequired {
                    setupRequired
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(client.snapshot.sections) { section in
                                // Needs you always shows, so an empty panel still answers the question.
                                if section.kind == .needsYou || !section.rows.isEmpty {
                                    SectionView(
                                        section: section,
                                        open: section.kind == .snoozed ? $snoozedOpen : .constant(true)
                                    )
                                }
                            }
                        }
                        .padding(.horizontal, 6).padding(.top, 4).padding(.bottom, 8)
                    }
                    .frame(maxHeight: listMaxHeight)
                }
                Divider()
                footer
            }
        }
        .frame(width: 440)
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
        .contentShape(Rectangle())
        .dragsPanel()
    }
}

/// The always-visible small component: the yellow needs-you count, the green working count, and
/// (collapsed) the ticker of rows that just came back to the owner. The chevron toggles the
/// expansion; the rest of the bar stays draggable so the panel can be repositioned.
struct CompactBar: View {
    @EnvironmentObject var client: DaemonClient
    @Binding var expanded: Bool

    var body: some View {
        HStack(spacing: 8) {
            if client.online && client.setupRequired {
                Text("setup required").font(.system(size: 11)).foregroundStyle(.yellow)
                Spacer(minLength: 6)
            } else if client.online {
                needsYouCount
                if client.working > 0 {
                    HStack(spacing: 4) {
                        Circle().fill(Color.green).frame(width: 6, height: 6)
                        Text("\(client.working)")
                    }
                    .font(.system(size: 11, weight: .semibold)).foregroundStyle(.green)
                }
                if !expanded && !fresh.isEmpty {
                    FreshTicker(items: fresh)
                        .frame(maxWidth: .infinity, alignment: .leading)
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
        .dragsPanel()
    }

    private var needsYouCount: some View {
        let count = client.needsYou
        return Text("\(count)")
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(count > 0 ? Color.black.opacity(0.85) : Color.secondary)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .frame(minWidth: 20)
            .background(Capsule().fill(count > 0 ? Color.yellow : Color.primary.opacity(0.12)))
    }

    /// Threads whose turn finished in the last 5 min — what the soft pulse cycles through.
    private var fresh: [SessionStateRow] { client.freshNeedsYou() }
}

extension View {
    /// Drags the floating panel from this view: background dragging (`isMovableByWindowBackground`)
    /// does not move the panel when the press lands on SwiftUI content.
    func dragsPanel() -> some View { modifier(PanelDrag()) }
}

private struct PanelDrag: ViewModifier {
    @State private var start: (panel: NSPoint, mouse: NSPoint)?

    func body(content: Content) -> some View {
        content.gesture(
            DragGesture(minimumDistance: 2)
                .onChanged { _ in
                    guard let panel = NSApp.windows.first(where: { $0 is FloatingPanel }) else { return }
                    let mouse = NSEvent.mouseLocation
                    let from = start ?? (panel.frame.origin, mouse)
                    start = from
                    panel.setFrameOrigin(NSPoint(x: from.panel.x + mouse.x - from.mouse.x, y: from.panel.y + mouse.y - from.mouse.y))
                }
                .onEnded { _ in start = nil }
        )
    }
}

private let projectBlue = Color(red: 0.40, green: 0.76, blue: 1.0)

private func lineText(_ r: SessionStateRow) -> Text {
    var proj = AttributeContainer(); proj.foregroundColor = projectBlue
    var out = AttributedString(r.repo, attributes: proj)
    var arrow = AttributeContainer(); arrow.foregroundColor = .secondary
    out.append(AttributedString("  →  ", attributes: arrow))
    var step = AttributeContainer(); step.foregroundColor = .primary
    out.append(AttributedString(r.displayStatusSummary ?? r.title, attributes: step))
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


/// One section: a Title 3 header with its root count, then its rows in daemon order. Snoozed
/// toggles open from its header and starts collapsed.
struct SectionView: View {
    @EnvironmentObject var client: DaemonClient
    let section: SectionRows
    @Binding var open: Bool

    private var collapsible: Bool { section.kind == .snoozed }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                if collapsible {
                    Image(systemName: open ? "chevron.down" : "chevron.right").font(.system(size: 11, weight: .semibold))
                }
                Text(section.kind.title).font(.title3.weight(.semibold))
                Text("\(section.count)").font(.title3.weight(.medium)).foregroundStyle(.tertiary)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8).padding(.top, 16).padding(.bottom, 6)
            .contentShape(Rectangle())
            .onTapGesture { if collapsible { open.toggle() } }

            if section.rows.isEmpty {
                Text("Nothing needs you").font(.system(size: 12)).foregroundStyle(.secondary)
                    .padding(.horizontal, 8).padding(.vertical, 6)
            }
            if open {
                ForEach(section.rows) { row in
                    RowView(
                        row: row,
                        onOpen: { client.open(row) },
                        onSnooze: { wake in withAnimation(.easeInOut(duration: 0.28)) { client.snooze(row.id, until: wake) } },
                        onWake: { withAnimation(.easeInOut(duration: 0.28)) { client.wake(row.id) } },
                        onDone: { withAnimation(.easeInOut(duration: 0.28)) { client.markDone(row.id) } },
                        onRename: { client.rename(row.id, to: $0) }
                    )
                    .transition(.opacity)
                }
            }
        }
    }
}

/// A session row as the approved mock lays it out: logo; title and time on line 1; blue repo,
/// status summary, and diff on line 2. Hovering a root swaps the right column for snooze (or
/// wake) and done buttons. A delegated child is one indented line with no actions.
struct RowView: View {
    let row: SessionStateRow
    let onOpen: () -> Void
    let onSnooze: (Date?) -> Void
    let onWake: () -> Void
    let onDone: () -> Void
    let onRename: (String) -> Void
    @State private var hovering = false
    @State private var editing = false
    @State private var statusSummaryExpanded = false
    @State private var draft = ""
    @FocusState private var titleFocused: Bool

    private var isChild: Bool { row.depth > 0 }
    private var showActions: Bool { hovering && !isChild && !editing }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            AppBadge(app: row.app, size: 16)
                .frame(width: 16, height: 16, alignment: .leading)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    title
                    statusSummaryDisclosure
                }
                if !isChild {
                    line2
                } else if let statusSummary = shownChildStatusSummary {
                    Text(statusSummary).font(.system(size: 12)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            rightColumn
        }
        .padding(.vertical, isChild ? 4 : 8)
        .padding(.leading, 8 + CGFloat(row.depth) * 26)
        .padding(.trailing, 8)
        .background(RoundedRectangle(cornerRadius: 8).fill(hovering ? Color.primary.opacity(0.06) : Color.clear))
        .contentShape(Rectangle())
        .onTapGesture { onOpen() }
        .onHover { hovering = $0 }
        .help(row.link == nil ? "" : "Open in \(row.app)")
        .contextMenu {
            Button("Rename…") { startEditing() }
            if row.isRenamed {
                Button("Use AI title") { onRename("") }
            }
        }
    }

    /// The title, or its inline editor while renaming. Return commits, Escape cancels. A double
    /// click renames; a single click falls through to opening the thread.
    @ViewBuilder private var title: some View {
        if editing {
            TextField("title", text: $draft, axis: .vertical)
                .textFieldStyle(.plain).font(.system(size: isChild ? 13 : 14))
                .fixedSize(horizontal: false, vertical: true)
                .background(RoundedRectangle(cornerRadius: 3).fill(Color.primary.opacity(0.08)).padding(-2))
                .focused($titleFocused)
                .onSubmit { editing = false; commit() }
                .onExitCommand { editing = false }
        } else {
            Text(row.title)
                .font(.system(size: isChild ? 13 : 14, weight: !isChild && row.section == .needsYou ? .semibold : .regular))
                .foregroundStyle(isChild ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                .lineLimit(1).truncationMode(.tail)
                .gesture(TapGesture(count: 2).onEnded { startEditing() }.exclusively(before: TapGesture().onEnded { onOpen() }))
        }
    }

    /// Age, yellow when the row needs you and behind a green dot while it works; a snoozed row
    /// shows when it comes back instead.
    @ViewBuilder private var timeColumn: some View {
        let age = shortAge(row.lastActive)
        Group {
            if row.section == .snoozed && !isChild {
                Text(row.snooze.map { snoozeLabel($0) } ?? age).foregroundStyle(.secondary)
            } else if isChild ? row.state == .working : row.section == .working {
                HStack(spacing: 5) {
                    Circle().fill(Color.green).frame(width: 6, height: 6)
                    Text(age).foregroundStyle(.secondary)
                }
            } else if !isChild && row.section == .needsYou {
                Text(age).foregroundStyle(.yellow).fontWeight(.semibold)
            } else {
                Text(age).foregroundStyle(.secondary)
            }
        }
        .font(.system(size: 12))
    }

    private var line2: some View {
        var repo = AttributeContainer(); repo.foregroundColor = projectBlue
        var out = AttributedString(row.repo, attributes: repo)
        if let statusSummary = row.displayStatusSummary {
            var summary = AttributeContainer(); summary.foregroundColor = .secondary
            out.append(AttributedString("  \(statusSummary)", attributes: summary))
        }
        return Text(out).font(.system(size: 13)).fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder private var diff: some View {
        if row.diffAdded != nil || row.diffDeleted != nil {
            HStack(spacing: 4) {
                // Verbatim: a localized interpolation groups digits ("2 037").
                Text(verbatim: "+\(row.diffAdded ?? 0)").foregroundStyle(.green)
                Text(verbatim: "−\(row.diffDeleted ?? 0)").foregroundStyle(.red)
            }
            .font(.system(size: 12))
        }
    }

    private var rightColumn: some View {
        ZStack(alignment: .topTrailing) {
            VStack(alignment: .trailing, spacing: 3) {
                timeColumn.padding(.top, 2)
                if !isChild { diff }
            }
            .opacity(showActions ? 0 : 1)
            if !isChild {
                actions.opacity(showActions ? 1 : 0).allowsHitTesting(showActions)
            }
        }
    }

    private var actions: some View {
        HStack(spacing: 4) {
            if row.section == .snoozed {
                IconButton(systemName: "arrow.up.to.line", help: "Wake now", action: onWake)
            } else {
                Menu {
                    ForEach(SnoozePreset.available()) { preset in
                        Button(menuTitle(preset)) { onSnooze(preset.wake()) }
                    }
                } label: {
                    Image(systemName: "clock").font(.system(size: 12))
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden)
                .frame(width: 24, height: 24)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.08)))
                .help("Snooze")
            }
            IconButton(systemName: "checkmark", help: "Mark done", action: onDone)
        }
    }

    private func menuTitle(_ preset: SnoozePreset) -> String {
        guard let wake = preset.wake() else { return preset.label }
        return "\(preset.label)    \(snoozeLabel(.until(wake)))"
    }

    /// A delegated child keeps its status summary folded until the owner opens it.
    private var shownChildStatusSummary: String? {
        statusSummaryExpanded ? row.displayStatusSummary : nil
    }

    @ViewBuilder private var statusSummaryDisclosure: some View {
        if row.statusSummaryStartsCollapsed, row.displayStatusSummary != nil {
            Button { statusSummaryExpanded.toggle() } label: {
                Image(systemName: statusSummaryExpanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 9)).foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .frame(width: 10)
            .help(statusSummaryExpanded ? "Hide this delegated run's status summary" : "Show this delegated run's status summary")
        }
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
}

/// A 24pt icon button, the mock's hover action.
struct IconButton: View {
    let systemName: String
    let help: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName).font(.system(size: 12, weight: .semibold))
                .frame(width: 24, height: 24)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(hovering ? 0.18 : 0.08)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(hovering ? .primary : .secondary)
        .onHover { hovering = $0 }
        .help(help)
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
    var size: CGFloat = 11

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
        ("Owner Operator", "owner-operator", true),
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
                .frame(width: size, height: size)
                .foregroundStyle(.secondary) // tints template marks; full-color marks ignore it
                .onHover { hovering = $0 }
                .overlay(alignment: .trailing) {
                    if hovering {
                        Text(app).foregroundStyle(.secondary).font(.system(size: 10))
                            .padding(.horizontal, 4).padding(.vertical, 1)
                            .background(RoundedRectangle(cornerRadius: 3).fill(.background))
                            .fixedSize()
                            .offset(x: -(size + 3)) // float just left of the mark
                            .allowsHitTesting(false)
                    }
                }
        } else {
            Text(app).foregroundStyle(.tertiary).font(.system(size: 10))
        }
    }
}
