declare module "@babel/generator" {
  const generate: (ast: unknown, options?: Record<string, unknown>) => { code: string }
  export default generate
}
