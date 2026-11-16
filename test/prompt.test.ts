import { assert } from "chai";
import {
  DEFAULT_SYSTEM_PROMPT,
  renderSystemPrompt,
  strictnessRule,
} from "../src/modules/prompt";

describe("prompt", function () {
  it("should map the strictness slider onto tag count ranges", function () {
    assert.deepEqual(
      [strictnessRule(0).tagMin, strictnessRule(0).tagMax],
      [6, 12],
    );
    assert.deepEqual(
      [strictnessRule(50).tagMin, strictnessRule(50).tagMax],
      [4, 7],
    );
    assert.deepEqual(
      [strictnessRule(100).tagMin, strictnessRule(100).tagMax],
      [2, 4],
    );
    assert.include(strictnessRule(100).instruction, "very strict");
  });

  it("should substitute every placeholder of the default prompt", function () {
    const prompt = renderSystemPrompt(DEFAULT_SYSTEM_PROMPT, {
      strictness: 100,
      synonymGroups: [["methane", "ch4"]],
    });
    assert.notInclude(prompt, "{{");
    assert.include(prompt, "between 2 and 4 tags");
    assert.include(prompt, strictnessRule(100).instruction);
    assert.include(prompt, "Synonym groups");
    assert.include(prompt, "methane; ch4");
  });

  it("should drop the synonym section when there are no synonyms", function () {
    const prompt = renderSystemPrompt(DEFAULT_SYSTEM_PROMPT, {
      strictness: 50,
      synonymGroups: [],
    });
    assert.notInclude(prompt, "Synonym groups");
    assert.isTrue(prompt.endsWith("No explanation."));
  });

  it("should honour a custom template and keep unknown placeholders", function () {
    const prompt = renderSystemPrompt(
      "Pick {{ tagMin }}-{{tagMax}} tags. {{unknown}}",
      { strictness: 0, synonymGroups: [] },
    );
    assert.equal(prompt, "Pick 6-12 tags. {{unknown}}");
  });
});
