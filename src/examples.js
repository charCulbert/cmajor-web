import upstreamCatalog from "./generated/cmajor-example-catalog.json";

const upstreamRevision = "4ba0924f3933d9650fb6a8f01f652a7236344604";
const upstreamExamples = upstreamCatalog.map((project) => ({
  id: project.id,
  name: project.name,
  attribution: `Official Cmajor ${project.name} example, fetched verbatim from cmajor-lang/cmajor ${upstreamRevision.slice(0, 7)}.`,
  upstreamProject: project,
  sourceRoot: `https://raw.githubusercontent.com/cmajor-lang/cmajor/${upstreamRevision}/examples/patches/${project.directory.split("/").map(encodeURIComponent).join("/")}/`,
}));

export const examples = [
  ...upstreamExamples.filter(({ name }) => name === "Pro54"),
  ...upstreamExamples.filter(({ name }) => name !== "Pro54"),
];

export function manifestFor(exampleName = "Playground", example = null) {
  if (example?.manifest) return example.manifest;
  return {
    CmajorVersion: 1,
    ID: "dev.cmajor.web.playground",
    version: "1.0",
    name: exampleName,
    description: "A patch compiled in the browser by cmajor-web",
    manufacturer: "cmajor-web",
    category: "generator",
    isInstrument: false,
    source: "main.cmajor",
  };
}
