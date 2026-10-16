import SwiftUI
import WorkerDeckCore
import WorkerDeckKit

/// The facets, the two layout choices, and how much of each card's child lists
/// (agents, shells, tasks) is drawn. Search is its own toggle in the title bar;
/// everything else lives here, which is why the subset line above the list is
/// unconditional - with this menu closed it is the only thing saying rows are
/// hidden.
///
/// It reads the core list's `ListFilter` and writes straight to the core
/// `SessionList`; `changed` tells the owner to redraw and persist, since the core
/// is not observable.
///
/// **A view of its own, and `Equatable` over plain values.** Its inputs derived
/// from the rows (`adapters`, `projects`) are passed as values, so a poll that
/// brought no new engine changes nothing here and an open dropdown stays open.
/// The list and the callback are deliberately not in the `==`.
struct FilterMenu: View, Equatable {
  struct Gateway: Equatable, Identifiable {
    let id: UUID
    let name: String
  }

  let filter: ListFilter
  let hosts: [Gateway]
  let adapters: [String]
  let projects: [ProjectOption]
  let list: SessionList
  let changed: () -> Void

  nonisolated static func == (lhs: FilterMenu, rhs: FilterMenu) -> Bool {
    lhs.hosts == rhs.hosts && lhs.adapters == rhs.adapters && lhs.projects == rhs.projects
      && lhs.filter == rhs.filter
  }

  private static let states: [(RowState, String)] = [
    (.attention, "Needs attention"), (.working, "Working"), (.idle, "Idle"), (.ended, "Ended"),
  ]

  var body: some View {
    Menu {
      Section("State") {
        ForEach(Self.states, id: \.0) { state, label in
          Toggle(label, isOn: toggle(filter.states.contains(state)) { list.toggleState(state: state) })
        }
      }
      if hosts.count > 1 {
        Section("Gateway") {
          ForEach(hosts) { host in
            facet(host.name, .gateway, host.id.uuidString, filter.gateways)
          }
        }
      }
      if adapters.count > 1 {
        Section("Engine") {
          ForEach(adapters, id: \.self) { adapter in
            facet(adapter, .adapter, adapter, filter.adapters)
          }
        }
      }
      if projects.count > 1 {
        Section("Project") {
          ForEach(projects) { project in
            facet(project.label, .project, project.key, filter.projects)
          }
        }
      }
      Section {
        Menu("Group by") {
          Picker("Group by", selection: pick(filter.groupBy) { list.setGroupBy(groupBy: $0) }) {
            Text("None").tag(ListGroupBy.none)
            Text("Engine").tag(ListGroupBy.adapter)
            Text("State").tag(ListGroupBy.state)
            Text("Project").tag(ListGroupBy.project)
          }
        }
        Menu("Sort by") {
          Picker("Sort by", selection: pick(filter.sortBy) { list.setSortBy(sortBy: $0) }) {
            Text("Recent").tag(ListSortBy.recent)
            Text("Name").tag(ListSortBy.name)
            Text("Gateway").tag(ListSortBy.gateway)
            Text("Engine").tag(ListSortBy.adapter)
            Text("State").tag(ListSortBy.state)
            Text("Project").tag(ListSortBy.project)
          }
        }
      }
      Section("Show under each session") {
        display("Agents", .agent, filter.agents)
        display("Shells", .shell, filter.shells)
        display("Tasks", .task, filter.tasks)
      }
    } label: {
      Label(
        "Filter",
        systemImage: filter.engaged
          ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
    }
    .accessibilityIdentifier("Filter")
  }

  /// One card display as a submenu that names its current value, the same three
  /// choices the dashboard's segmented control offers.
  private func display(_ label: String, _ kind: StepKind, _ value: StepShow) -> some View {
    Picker(label, selection: pick(value) { list.setStepDisplay(kind: kind, show: $0) }) {
      Text("All").tag(StepShow.all)
      Text("Active").tag(StepShow.active)
      Text("Hide").tag(StepShow.hide)
    }
    .pickerStyle(.menu)
  }

  private func facet(_ label: String, _ facet: ListFacet, _ value: String, _ chosen: [String]) -> some View {
    Toggle(label, isOn: toggle(chosen.contains(value)) { list.toggleFacet(facet: facet, value: value) })
  }

  private func toggle(_ on: Bool, _ flip: @escaping () -> Void) -> Binding<Bool> {
    Binding(
      get: { on },
      set: { next in
        guard next != on else { return }
        flip()
        changed()
      })
  }

  private func pick<Value: Hashable>(_ value: Value, _ set: @escaping (Value) -> Void) -> Binding<Value> {
    Binding(
      get: { value },
      set: { next in
        set(next)
        changed()
      })
  }
}
