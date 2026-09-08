/** The parameters the plug-in exposes, in its order: the same rule as Engine::parseV3. */
export function parametersOf(meta) {
  const primitive = (kind) => kind && kind !== 'pointer' && kind !== 'void';
  return meta.inputs.filter((input) => input.purpose === 'parameter'
    && ((input.kind === 'event' && input.events?.length === 1 && primitive(input.events[0].valueKind))
      || (input.kind === 'value' && primitive(input.valueKind)))).slice(0, 128);
}
