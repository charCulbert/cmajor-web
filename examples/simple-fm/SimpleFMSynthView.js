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
                    width: 560px;
                    height: 300px;
                    color: var(--ink, #eeeeea);
                    background: var(--panel, #121414);
                    font-family: var(--ui, ui-sans-serif, system-ui, sans-serif);
                }
                * { box-sizing: border-box; }
                main {
                    height: 100%;
                    overflow: hidden;
                    padding: 24px;
                    background: var(--panel, #121414);
                }
                header {
                    display: flex;
                    align-items: baseline;
                    justify-content: space-between;
                    margin-bottom: 10px;
                    padding-bottom: 14px;
                    border-bottom: 1px solid var(--rule, #303434);
                }
                h1 { margin: 0; font-size: 18px; font-weight: 500; letter-spacing: -0.02em; }
                header span { color: var(--faint, #7f8985); font: 11px var(--mono, ui-monospace, monospace); }
                .controls { display: grid; }
                label {
                    display: grid;
                    grid-template-columns: 7rem minmax(0, 1fr) 4.5rem;
                    gap: 14px;
                    align-items: center;
                    min-height: 48px;
                    border-bottom: 1px solid var(--rule-faint, #242727);
                }
                .name { color: var(--ink2, #bdc5c1); font-size: 12px; }
                output { color: var(--val, #9ac7ff); font: 12px var(--mono, ui-monospace, monospace); font-variant-numeric: tabular-nums; text-align: right; }
                input {
                    width: 100%;
                    height: 18px;
                    margin: 0;
                    accent-color: var(--sel, #72d6a1);
                    cursor: ew-resize;
                }
            </style>
            <main>
                <header>
                    <h1>Simple FM</h1>
                    <span>8 voices · MIDI</span>
                </header>
                <section class="controls"></section>
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
