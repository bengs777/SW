export type DashboardCardProps = {
  label: string
  value: string
  detail?: string
}

const defaultProps = {
  detail: "Updated recently",
}

export function DashboardCard(props: DashboardCardProps) {
  return (
    <article className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-medium text-slate-500">{props.label}</p>
      <p className="mt-2 text-3xl font-bold text-slate-950">{props.value}</p>
      <p className="mt-2 text-sm text-slate-600">{props.detail || defaultProps.detail}</p>
    </article>
  )
}
