import WorkerDeckKit
import SwiftUI

/// The facets, the two layout choices, and how much of each card's child lists
/// (agents, shells, tasks) is drawn. Search is its own toggle in the title bar;
/// everything else lives here, which is why the subset line above the list is
/// unconditional - with this menu closed it is the only thing saying rows are
/// hidden.
///
/// **A view of its own, and `Equatable` over plain values.** It used to be a
/// method on the list, which meant its body read `model.adapters` - a property
/// *computed from the session rows* - so `@Observable` invalidated it on every
/// one of the 1.2s poll's refreshes, and an open dropdown closed itself as soon
/// as anything moved. An unread badge ticking up was enough. Taking `hosts` and
/// `adapters` as values means SwiftUI can see that a refresh which brought no
/// new engine and no new gateway changes nothing here, and skip the body
/// entirely; the `config` binding still writes straight through to the model.
///
/// The `Binding` is deliberately not in the `==`: two bindings are never equal
/// and comparing them would defeat the whole thing. It is safe to leave out
/// because the *values* it reads - `config` - are covered by `configSnapshot`.
struct FilterMenu: View, Equatable {
  struct Gateway: Equatable, Identifiable {
    let id: UUID
    let name: String
  }

  @Binding var config: ViewConfig
  let hosts: [Gateway]
  let adapters: [String]
  /// Passed as a *value* for the same reason `adapters` is: it is derived from
  /// the session rows, so reading it off the model inside this body would make
  /// every 1.2s refresh invalidate the menu and shut an open dropdown. It is in
  /// the `==` below for the other half of that rule.
  let projects: [ProjectOption]

  /// `nonisolated` because SwiftUI compares views off the main actor. It only
  /// touches value types, so there is nothing to race on.
  nonisolated static func == (lhs: FilterMenu, rhs: FilterMenu) -> Bool {
    lhs.hosts == rhs.hosts && lhs.adapters == rhs.adapters && lhs.projects == rhs.projects
      && lhs.config == rhs.config
  }

  var body: some View {
    Menu {
      Section("State") {
        ForEach(SessionState.order, id: \.self) { state in
          Toggle(state.label, isOn: membership(\.states, state))
        }
      }
      if hosts.count > 1 {
        Section("Gateway") {
          ForEach(hosts) { host in
            Toggle(host.name, isOn: membership(\.gateways, host.id.uuidString))
          }
        }
      }
      if adapters.count > 1 {
        Section("Engine") {
          ForEach(adapters, id: \.self) { adapter in
            Toggle(adapter, isOn: membership(\.adapters, adapter))
          }
        }
      }
      if projects.count > 1 {
        Section("Project") {
          ForEach(projects) { project in
            Toggle(project.label, isOn: membership(\.projects, project.key))
          }
        }
      }
      Section {
        Menu("Group by") {
          Picker("Group by", selection: $config.groupBy) {
            Text("None").tag(GroupBy.none)
            Text("Engine").tag(GroupBy.adapter)
            Text("State").tag(GroupBy.state)
            Text("Project").tag(GroupBy.project)
          }
        }
        Menu("Sort by") {
          Picker("Sort by", selection: $config.sortBy) {
            Text("Recent").tag(SortBy.recent)
            Text("Name").tag(SortBy.name)
            Text("Gateway").tag(SortBy.gateway)
            Text("Engine").tag(SortBy.adapter)
            Text("State").tag(SortBy.state)
            Text("Project").tag(SortBy.project)
          }
        }
      }
      Section("Show under each session") {
        display("Agents", \.subagents)
        display("Shells", \.shells)
        display("Tasks", \.tasks)
      }
    } label: {
      Label(
        "Filter",
        systemImage: engaged
          ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
    }
    .accessibilityIdentifier("Filter")
  }

  /// The funnel fills while a facet is filtering or a card display is off its
  /// default. Search shows its own state in the search field.
  private var engaged: Bool {
    facetFilterCount(config) > 0 || displayCustomized(config)
  }

  /// One card display as a submenu that names its current value, the same three
  /// choices the dashboard's segmented control offers.
  private func display(_ label: String, _ keyPath: WritableKeyPath<ViewConfig, StepDisplay>)
    -> some View
  {
    Picker(label, selection: Binding(get: { config[keyPath: keyPath] }, set: { config[keyPath: keyPath] = $0 })) {
      Text("All").tag(StepDisplay.all)
      Text("Active").tag(StepDisplay.active)
      Text("Hide").tag(StepDisplay.none)
    }
    .pickerStyle(.menu)
  }

  /// A Toggle binding for membership of one value in one facet array.
  private func membership<Value: Equatable>(
    _ keyPath: WritableKeyPath<ViewConfig, [Value]>, _ value: Value
  ) -> Binding<Bool> {
    Binding(
      get: { config[keyPath: keyPath].contains(value) },
      set: { on in
        if on {
          if !config[keyPath: keyPath].contains(value) { config[keyPath: keyPath].append(value) }
        } else {
          config[keyPath: keyPath].removeAll { $0 == value }
        }
      })
  }
}
