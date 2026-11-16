// A query policy for the tests: refuses anything that names big_table, after
// an await, so the proxy's ordering under an async policy is exercised too.
export default async function policy({ args }) {
  await new Promise((resolve) => setTimeout(resolve, 5));
  return JSON.stringify(args).includes("big_table") ? "big_table needs a time filter" : undefined;
}
