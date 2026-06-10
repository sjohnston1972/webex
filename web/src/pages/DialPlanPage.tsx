import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import { Card, Empty, Spinner } from "../components";

type DialPlanRow = {
  id: string;
  object_type: string;
  name: string;
  partition_name: string | null;
  description: string | null;
  detail: string | null;
};

const TYPE_ORDER: [string, string][] = [
  ["route_pattern", "Route patterns"],
  ["sip_route_pattern", "SIP route patterns"],
  ["translation_pattern", "Translation patterns"],
  ["directory_number", "Directory numbers"],
  ["hunt_pilot", "Hunt pilots"],
  ["pickup_group_number", "Pickup group numbers"],
  ["call_park", "Call park"],
  ["meet_me", "Meet-Me conference"],
  ["conference", "Conference numbers"],
  ["message_waiting", "Message waiting"],
  ["elin", "Emergency location numbers"],
  ["device_template", "Device templates"],
  ["route_partition", "Route partitions"],
  ["css", "Calling search spaces"],
  ["route_list", "Route lists"],
  ["route_group", "Route groups"],
  ["sip_trunk", "SIP trunks"],
];

export function DialPlanPage() {
  const { projectId } = useParams();
  const [rows, setRows] = useState<DialPlanRow[] | null>(null);

  useEffect(() => {
    api.get<DialPlanRow[]>(`/api/projects/${projectId}/objects/dialplan`).then(setRows).catch(() => setRows([]));
  }, [projectId]);

  if (!rows) return <Spinner />;

  const grouped = new Map<string, DialPlanRow[]>();
  for (const r of rows) {
    if (!grouped.has(r.object_type)) grouped.set(r.object_type, []);
    grouped.get(r.object_type)!.push(r);
  }
  const orderedTypes: [string, string][] = [
    ...TYPE_ORDER.filter(([t]) => grouped.has(t)),
    ...[...grouped.keys()].filter((t) => !TYPE_ORDER.some(([k]) => k === t)).map((t) => [t, t] as [string, string]),
  ];

  return (
    <>
      <div className="page-head toolbar">
        <div>
          <h1 className="page-title">Dial plan</h1>
          <p className="page-desc">
            The complete CUCM route plan (every pattern in the system) plus routing infrastructure. Reference for the engineer — dial-plan
            routing is configured manually in Control Hub, except translation patterns which can be mapped on the Review page.
          </p>
        </div>
        <div className="grow" />
        <a className="btn" href={`/api/projects/${projectId}/reports/dialplan.csv`}>
          ⤓ Dial plan CSV
        </a>
      </div>

      {rows.length === 0 ? (
        <Card>
          <Empty glyph="☎">No dial plan data — run an AXL pull on the Source page.</Empty>
        </Card>
      ) : (
        orderedTypes.map(([type, label]) => {
          const items = grouped.get(type)!;
          return (
            <Card key={type} title={label} sub={`${items.length}`} tight>
              <table className="data">
                <thead>
                  <tr>
                    <th>Pattern / Name</th>
                    <th>Partition</th>
                    <th>Description</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => (
                    <tr key={r.id}>
                      <td className="mono">{r.name}</td>
                      <td>{r.partition_name ?? <span className="dim">—</span>}</td>
                      <td className="notes">{r.description ?? ""}</td>
                      <td className="notes">{r.detail ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          );
        })
      )}
    </>
  );
}
