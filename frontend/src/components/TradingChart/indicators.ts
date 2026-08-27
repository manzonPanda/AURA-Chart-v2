import {
  createBuiltinRegistry,
  IndicatorController,
  type IndicatorDef,
} from "@getcandlekit/charts";

/**
 * Builds the indicator controller with EMA 20 and EMA 50 on the price pane.
 *
 * CandleKit keys active indicators by NAME, so a single built-in "EMA" cannot
 * be registered twice. To render two EMAs we register two clones of the
 * built-in EMA definition (reusing its exact `calculate` implementation — no
 * hand-rolled math) under distinct names and distinct colours.
 */
export function createEmaIndicators(): IndicatorController {
  const registry = createBuiltinRegistry();
  const base = registry.get("EMA");

  if (base) {
    const clone = (
      name: string,
      title: string,
      shortTitle: string,
      length: number,
      color: string,
    ): void => {
      const plot = base.plotConfig[0] ? { ...base.plotConfig[0], color } : { id: "ema", color };
      const def: IndicatorDef = {
        ...base,
        name,
        title,
        shortTitle,
        plotConfig: [plot],
        defaultInputs: { ...base.defaultInputs, length },
        calculate: (bars, inputs) => base.calculate(bars, { ...inputs, length }),
      };
      registry.register(def);
    };

    clone("EMA20", "EMA 20", "EMA-20", 20, "#38bdf8");
    clone("EMA50", "EMA 50", "EMA-50", 50, "#fb923c");
  }

  const controller = new IndicatorController(registry);
  if (base) {
    controller.add("EMA20");
    controller.add("EMA50");
  }
  return controller;
}