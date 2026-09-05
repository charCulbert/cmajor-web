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
  {
    id: "sine",
    name: "Sine tone",
    attribution: "Adapted from the Cmajor Getting Started guide (GPL-3.0-or-later).",
    source: `// Sine tone — adapted from the Cmajor Getting Started guide.
processor Playground [[ main ]]
{
    output stream float out;
    input event float frequency [[ name: "Frequency", min: 80, max: 1200, init: 220, unit: "Hz" ]];
    input event float level [[ name: "Level", min: 0, max: 0.3, init: 0.12, step: 0.01 ]];

    event frequency (float value) { phaseDelta = float (value * processor.period * twoPi); }
    event level (float value) { gain = value; }

    void main()
    {
        phaseDelta = float (220.0 * processor.period * twoPi);
        gain = 0.12f;
        loop
        {
            out <- gain * sin (phase);
            phase = addModulo2Pi (phase, phaseDelta);
            advance();
        }
    }

    float phase, phaseDelta, gain;
}`,
  },
  {
    id: "beating",
    name: "Beating oscillators",
    attribution: "Original cmajor-web example by Charlie Culbert (GPL-3.0-or-later).",
    source: `// Two nearby tones create a slow acoustic beat.
processor Playground [[ main ]]
{
    output stream float out;
    input event float frequency [[ name: "Centre", min: 80, max: 880, init: 220, unit: "Hz" ]];
    input event float beating [[ name: "Beating", min: 0.1, max: 12, init: 2, unit: "Hz" ]];

    event frequency (float value) { centre = value; update(); }
    event beating (float value) { offset = value; update(); }

    void update()
    {
        d1 = float ((centre - offset * 0.5f) * processor.period * twoPi);
        d2 = float ((centre + offset * 0.5f) * processor.period * twoPi);
    }

    void main()
    {
        centre = 220.0f; offset = 2.0f; update();
        loop
        {
            out <- 0.07f * (sin (p1) + sin (p2));
            p1 = addModulo2Pi (p1, d1); p2 = addModulo2Pi (p2, d2);
            advance();
        }
    }

    float centre, offset, p1, p2, d1, d2;
}`,
  },
  {
    id: "hello",
    name: "Gran Vals melody",
    attribution: "From Cmajor's HelloWorld example; Francisco Tárrega melody (GPL-3.0-or-later).",
    source: `/** A snippet of Gran Vals by Francisco Tárrega.
    From Cmajor's HelloWorld example. */
processor Playground [[ main ]]
{
    output stream float out;
    input event float level [[ name: "Level", min: 0, max: 0.3, init: 0.12, step: 0.01 ]];
    event level (float value) { gain = value; }

    struct Note
    {
        int pitch, length;
        void play() const
        {
            let frames = this.length * int (processor.frequency / 7);
            let delta = float (std::notes::noteToFrequency (this.pitch) * processor.period * twoPi);
            loop (frames) { out <- gain * sin (phase); phase = addModulo2Pi (phase, delta); advance(); }
        }
    }

    void main()
    {
        gain = 0.12f;
        let melody = Note[] ((79, 1), (77, 1), (69, 2), (71, 2), (76, 1),
                             (74, 1), (65, 2), (67, 2), (74, 1), (72, 1),
                             (64, 2), (67, 2), (72, 4));
        loop { for (wrap<melody.size> i) melody[i].play(); }
    }
    float phase, gain;
}`,
  },
  ...upstreamExamples,
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
