import { useOutletContext, useParams } from "react-router-dom";
import { Card, Empty } from "../components";
import type { ProjectContext } from "../App";

export function ReportsPage() {
  const { summary } = useOutletContext<ProjectContext>();
  const { projectId } = useParams();

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Reports</h1>
        <p className="page-desc">CSV exports — customer deliverables for the engagement.</p>
      </div>

      <Card title="Pre-migration readiness">
        <p className="dim small" style={{ marginTop: 0 }}>
          Every mapped object with its readiness state, selection and outstanding issues (no email, unsupported items, unresolved members).
        </p>
        <a className="btn" href={`/api/projects/${projectId}/reports/readiness.csv`}>
          ⤓ Download readiness report
        </a>
      </Card>

      <Card title="Batch reports" tight>
        {summary.batches.length === 0 ? (
          <Empty>No batches yet — dry-run and post-push reports appear here per batch.</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Batch</th>
                <th>Status</th>
                <th>Dry-run report</th>
                <th>Post-push report</th>
              </tr>
            </thead>
            <tbody>
              {summary.batches.map((b) => (
                <tr key={b.id}>
                  <td>{b.name}</td>
                  <td>{b.status}</td>
                  <td>
                    <a className="btn sm" href={`/api/projects/${projectId}/batches/${b.id}/dryrun.csv`}>
                      ⤓ CSV
                    </a>
                  </td>
                  <td>
                    <a className="btn sm" href={`/api/projects/${projectId}/batches/${b.id}/result.csv`}>
                      ⤓ CSV
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
