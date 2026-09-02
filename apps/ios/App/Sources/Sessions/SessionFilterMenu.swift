import WorkerDeckKit
import SwiftUI

/// The three facets plus the two layout choices. Search is `.searchable` on the
/// list itself; everything else lives here, which is why the subset line above
/// the list is unconditional — with this menu closed it is the only thing saying
/// rows are hidden.
///
/// **A view of its own, and `Equatable` over plain values.** It used to be a
/// method on the list, which meant its body read `model.adapters` — a property
/// *computed from the session rows* — so `@Observable` invalidated it on every
/// one of the 1.2s poll's refreshes, and an open dropdown closed itself as soon
/// as anything moved. An unread badge ticking up was enough. Taking `hosts` and
/// `adapters` as values means SwiftUI can see that a refresh which brought no
/// new engine and no new gateway changes nothing here, and skip the body
/// entirely; the `config` binding still writes straight through to the model.
///
/// The `Binding` is deliberately not in the `==`: two bindings are never equal
/// and comparing them would defeat the whole thing. It is safe to leave out
/// because the *values* it reads — `config` — are covered by `configSnapshot`.
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
            Text("Gateway").tag(GroupBy.gateway)
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
    } label: {
      Label(
        "Filter",
        systemImage: facetFilterOn
          ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
    }
  }

  /// Whether a *facet* is filtering (the funnel's fill). Search shows its own
  /// state in the search field, so it does not light the funnel too.
  private var facetFilterOn: Bool {
    !config.gateways.isEmpty || !config.adapters.isEmpty || !config.states.isEmpty
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
