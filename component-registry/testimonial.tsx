export type TestimonialProps = {
  quote: string
  author: string
  role?: string
}

const defaultProps = {
  role: "Customer",
}

export function Testimonial(props: TestimonialProps) {
  return (
    <figure className="rounded-lg border border-slate-200 bg-slate-50 p-6">
      <blockquote className="text-lg font-medium text-slate-900">"{props.quote}"</blockquote>
      <figcaption className="mt-4 text-sm text-slate-600">
        <span className="font-semibold text-slate-900">{props.author}</span>
        <span> - {props.role || defaultProps.role}</span>
      </figcaption>
    </figure>
  )
}
