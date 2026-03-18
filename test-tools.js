import { PageAgent } from "page-agent";
const agent = new PageAgent({
  model: "test",
  baseURL: "http://test",
  apiKey: "test",
  customFetch: async (url, init) => {
    if (url.includes("/chat/completions")) {
      const body = JSON.parse(init.body);
      console.log(JSON.stringify(body.tools, null, 2));
      process.exit(0);
    }
  }
});
agent.run("test task").catch(e => console.error(e));
