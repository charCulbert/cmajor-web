const parameters = [
    { id: "carrierRatio", label: "Carrier", min: 0.25, max: 4, step: 0.25, initial: 1, format: value => `${value.toFixed (2)}×` },
    { id: "modulatorRatio", label: "Modulator", min: 0.25, max: 8, step: 0.25, initial: 2, format: value => `${value.toFixed (2)}×` },
    { id: "modulationIndex", label: "FM Index", min: 0, max: 12, step: 0.05, initial: 2.5, format: value => value.toFixed (2) },
    { id: "level", label: "Level", min: 0, max: 0.2, step: 0.005, initial: 0.08, format: value => value.toFixed (3) },
];

class SimpleFMSynthView extends HTMLElement
{
    constructor()
    {
        super();
        this.listeners = [];
        this.attachShadow ({ mode: "open" }).innerHTML = `
            <style>
                :host {
                    display: block;
                    width: 640px;
                    height: 400px;
                    color: #f3f5ef;
                    background: #0d1110;
                    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
                }
                * { box-sizing: border-box; }
                main {
                    position: relative;
                    height: 100%;
                    overflow: hidden;
                    padding: 34px 38px;
                    background:
                        linear-gradient(115deg, rgba(84, 255, 179, 0.09), transparent 42%),
                        radial-gradient(circle at 88% 12%, rgba(109, 181, 255, 0.15), transparent 35%),
                        #0d1110;
                }
                header { display: flex; align-items: end; justify-content: space-between; margin-bottom: 30px; }
                h1 { margin: 0; font-size: 34px; font-weight: 500; letter-spacing: -1.4px; }
                header span { color: #7f9189; font: 11px ui-monospace, monospace; letter-spacing: 0.18em; text-transform: uppercase; }
                .wave {
                    position: absolute;
                    top: 28px;
                    right: 38px;
                    width: 160px;
                    height: 42px;
                    opacity: 0.55;
                }
                .controls { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
                label {
                    display: grid;
                    grid-template-columns: 1fr auto;
                    gap: 18px 12px;
                    align-items: center;
                    min-width: 0;
                    padding: 20px;
                    border: 1px solid #27332f;
                    background: rgba(10, 14, 13, 0.76);
                }
                .name { color: #b7c4be; font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; }
                output { color: #77f7b8; font: 18px ui-monospace, monospace; font-variant-numeric: tabular-nums; }
                input {
                    grid-column: 1 / -1;
                    width: 100%;
                    height: 20px;
                    margin: 0;
                    accent-color: #68eaaa;
                    cursor: ew-resize;
                }
                footer { margin-top: 24px; color: #718078; font: 11px ui-monospace, monospace; letter-spacing: 0.08em; }
            </style>
            <main>
                <header>
                    <h1>Simple FM</h1>
                    <span>8 voice poly synth</span>
                </header>
                <svg class="wave" viewBox="0 0 160 42" aria-hidden="true">
                    <path d="M0 21 C10 2 20 2 30 21 S50 40 60 21 S80 2 90 21 S110 40 120 21 S140 2 160 21" fill="none" stroke="#78f0b5" stroke-width="2"/>
                </svg>
                <section class="controls"></section>
                <footer>PLAY FROM MIDI OR THE ON-SCREEN KEYBOARD</footer>
            </main>`;

        const controls = this.shadowRoot.querySelector (".controls");
        for (const parameter of parameters)
            controls.append (this.createControl (parameter));
    }

    set patchConnection (connection)
    {
        this.detachParameterListeners();
        this.connection = connection;
        if (this.isConnected) this.attachParameterListeners();
    }

    connectedCallback()    { this.attachParameterListeners(); }
    disconnectedCallback() { this.detachParameterListeners(); }

    createControl (parameter)
    {
        const label = document.createElement ("label");
        label.innerHTML = `<span class="name">${parameter.label}</span><output>${parameter.format (parameter.initial)}</output>`;
        const input = document.createElement ("input");
        input.type = "range";
        input.min = parameter.min;
        input.max = parameter.max;
        input.step = parameter.step;
        input.value = parameter.initial;
        input.dataset.endpoint = parameter.id;
        input.setAttribute ("aria-label", parameter.label);

        let gestureActive = false;
        const beginGesture = () => {
            if (!gestureActive)
            {
                gestureActive = true;
                this.connection?.sendParameterGestureStart (parameter.id);
            }
        };
        const endGesture = () => {
            if (gestureActive)
            {
                gestureActive = false;
                this.connection?.sendParameterGestureEnd (parameter.id);
            }
        };
        input.addEventListener ("pointerdown", beginGesture);
        input.addEventListener ("pointerup", endGesture);
        input.addEventListener ("pointercancel", endGesture);
        input.addEventListener ("input", () => {
            const value = Number (input.value);
            label.querySelector ("output").textContent = parameter.format (value);
            if (!gestureActive) this.connection?.sendParameterGestureStart (parameter.id);
            this.connection?.sendEventOrValue (parameter.id, value);
            if (!gestureActive) this.connection?.sendParameterGestureEnd (parameter.id);
        });
        label.append (input);
        return label;
    }

    attachParameterListeners()
    {
        if (!this.connection || this.listeners.length) return;
        for (const parameter of parameters)
        {
            const input = this.shadowRoot.querySelector (`[data-endpoint="${parameter.id}"]`);
            const output = input.parentElement.querySelector ("output");
            const listener = value => {
                input.value = value;
                output.textContent = parameter.format (Number (value));
            };
            this.connection.addParameterListener (parameter.id, listener);
            this.connection.requestParameterValue (parameter.id);
            this.listeners.push ({ id: parameter.id, listener });
        }
    }

    detachParameterListeners()
    {
        for (const { id, listener } of this.listeners)
            this.connection?.removeParameterListener (id, listener);
        this.listeners = [];
    }
}

if (!customElements.get ("simple-fm-synth-view"))
    customElements.define ("simple-fm-synth-view", SimpleFMSynthView);

export default function createPatchView (patchConnection)
{
    const view = document.createElement ("simple-fm-synth-view");
    view.patchConnection = patchConnection;
    return view;
}
