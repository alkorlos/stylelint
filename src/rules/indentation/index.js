import { repeat } from "lodash"
import {
  optionsHaveException,
  report,
  ruleMessages,
  styleSearch
} from "../../utils"

export const ruleName = "indentation"
export const messages = ruleMessages(ruleName, {
  expected: x => `Expected indentation of ${x}`,
})

// The hierarchyMap keeps track of nodes with confirmed
// superordinates and indentation levels.
// It can then be used by rules to check
// if they have a peer in the hierarchyMap, and should share that
// peer's superordinate. If a rule is not subordinate to the previous
// rule, we'll recursively check the hierarchyMap to see if
// the rule is still part of the hierarchical structure.
const hierarchyMap = new Map()

function addNodeToHierarchy(node, superordinate, level) {
  hierarchyMap.set(node, { superordinate, level })
}

/**
 * @param {number|"tab"} space - Number of whitespaces to expect, or else
 *   keyword "tab" for single `\t`
 * @param {object} [options]
 * @param {array} [options.except = ["block", "value"]] - Do *not* expect extra level of
 *   indentation should for nested blocks and multi-line values respectively
 * @param {array} [options.hierarchicalSelectors = false] - If `true`, we'll look for a
 *   hierarchical style of indentation, where rules whose selectors *start* with
 *   previous rule's selector will be indented (see tests and docs)
 */
export default function (space, options) {
  const isTab = space === "tab"
  const indentChar = (isTab) ? "\t" : repeat(" ", space)
  const warningWord = (isTab) ? "tab" : "space"

  return (root, result) => {
    // Cycle through all nodes using eachInside and then return early for
    // unrelated nodes. This is done instead of using
    // eachRule, eachAtRule, and eachDecl,
    // so that any hierarchy can be accounted for *in order*.
    root.eachInside(node => {
      if ([ "rule", "atrule", "decl" ].indexOf(node.type) === -1) { return }

      let nodeLevel = indentationLevel(node)

      if (options && options.hierarchicalSelectors) {
        // hierarchicalSelectorsLevel will add the node to the hierarchyMap
        nodeLevel = hierarchicalSelectorsLevel(node, nodeLevel)
      } else {
        // Add this node to the hierarchyMap for future reference.
        // If there isn't a selector hierarchy, then the superordinate
        // can only be the node's parent.
        addNodeToHierarchy(node, node.parent, nodeLevel)
      }

      const expectedWhitespace = repeat(indentChar, nodeLevel)

      const { before, after } = node

      // Only inspect the spaces before the node
      // if this is the first node in root
      // or there is a newline in the `before` string.
      // (If there is no newline before a node,
      // there is no "indentation" to check.)
      const inspectBefore = (root.first === node) || before.indexOf("\n") !== -1

      // Inspect whitespace in the `before` string that is
      // *after* the *last* newline character,
      // because anything besides that is not indentation for this node:
      // it is some other kind of separation, checked by some separate rule
      if (inspectBefore && before.slice(before.lastIndexOf("\n") + 1) !== expectedWhitespace) {
        report({
          message: messages.expected(legibleExpectation(nodeLevel, node.source.start.line)),
          node: node,
          line: node.source.start.line,
          result,
          ruleName,
        })
      }

      // Only blocks have the `after` string to check.
      // Only inspect `after` strings that start with a newline;
      // otherwise there's no indentation involved.
      if (after && after.indexOf("\n") !== -1
        && after.slice(after.lastIndexOf("\n") + 1) !== expectedWhitespace) {
        report({
          message: messages.expected(legibleExpectation(nodeLevel, node.source.end.line)),
          node: node,
          line: node.source.end.line,
          result,
          ruleName,
        })
      }

      // If this is a declaration, check the value
      if (node.value) {
        checkValue(node, nodeLevel)
      }

      // If this is a rule, check the selector
      if (node.selector) {
        checkSelector(node, nodeLevel)
      }
    })

    function indentationLevel(node, level=0) {
      if (node.parent.type === "root") { return level }

      let newLevel
      if (hierarchyMap.has(node.parent)) {
        // If the hierarchyMap already contains this node's
        // parent, refer to that level
        newLevel = hierarchyMap.get(node.parent).level + 1
      } else {
        // Typically, indentation level equals the ancestor nodes
        // separating this node from root; so recursively
        // run this operation
        newLevel = indentationLevel(node.parent, level + 1)
      }

      // If options.except includes "block",
      // blocks are taken down one from their calculated level
      // (all blocks are the same level as their parents)
      if (optionsHaveException(options, "block")
        && node.type !== "decl") {
        newLevel--
      }

      return newLevel
    }

    function checkValue(node, declLevel) {
      const value = node.value
      if (value.indexOf("\n") === -1) { return }

      const valueLevel = (optionsHaveException(options, "value"))
        ? declLevel
        : declLevel + 1

      styleSearch({ source: value, target: "\n" }, (match, newlineCount) => {
        // Starting at the index after the newline, we want to
        // check that the whitespace characters before the first
        // non-whitespace character equal the expected indentation
        const postNewlineActual = /^(\s*)\S/.exec(value.slice(match.startIndex + 1))[1]

        if (postNewlineActual !== repeat(indentChar, valueLevel)) {
          const line = node.source.start.line + newlineCount
          report({
            message: messages.expected(legibleExpectation(valueLevel, line)),
            node: node,
            line: line,
            result,
            ruleName,
          })
        }
      })
    }

    function checkSelector(rule, ruleLevel) {
      const selector = rule.selector
      if (selector.indexOf("\n") === -1) { return }

      styleSearch({ source: selector, target: "\n" }, (match, newlineCount) => {
        // Starting at the index after the newline, we want to
        // check that the whitespace characters before the first
        // non-whitespace character equal the expected indentation
        const postNewlineActual = /^(\s*)\S/.exec(selector.slice(match.startIndex + 1))[1]

        if (postNewlineActual !== repeat(indentChar, ruleLevel)) {
          const line = rule.source.start.line + newlineCount
          report({
            message: messages.expected(legibleExpectation(ruleLevel, line)),
            node: rule,
            line: line,
            result,
            ruleName,
          })
        }
      })
    }
  }

  function legibleExpectation(level, line) {
    const count = (isTab) ? level : level * space
    const quantifiedWarningWord = (count === 1)
      ? warningWord
      : warningWord + "s"
    return `${count} ${quantifiedWarningWord} at line ${line}`
  }
}

// Figure the correct level of indentation if this is a rule that is
// part of a hierarchy of selectors.
//
// In the hierarchy, Rule A is subordinate to Rule B if Rule A's
// selector starts with Rule B's selector. Each rule can be
// subordinate to one other rule, but superordinate to many.
//
// Subordinates do not always immediately follow their
// superordinates, so it would be overly simplistic to just
// check if any given rule is subordinate to the previous rule.
function hierarchicalSelectorsLevel(node, nodeLevel) {
  const prevNode = node.prev()

  if (node.type !== "rule" || !prevNode || prevNode.type !== "rule") {
    return nodeLevel
  }

  const isFirstSubordinate = node.selector.indexOf(prevNode.selector) === 0
  if (isFirstSubordinate) {
    const expectedLevel = (hierarchyMap.has(prevNode))
      ? hierarchyMap.get(prevNode).level + 1
      : nodeLevel + 1
    addNodeToHierarchy(node, prevNode, expectedLevel)
    return expectedLevel
  }

  // If this node is not subordinate to prevNode, but prevNode was itself a subordinate,
  // maybe this node is a peer of prevNode (and therefore should be subordinate to the
  // same superordinate). Or maybe it's a peer of prevNode's superordinate.
  // Recursively check the hierarchy in this manner for possible peers: if one
  // is found, use that peer's nodeLevel.
  let maybePeer = prevNode
  while (maybePeer) {
    if (hierarchyMap.has(maybePeer)) {
      const maybePeerInfo = hierarchyMap.get(maybePeer)
      if (node.selector.indexOf(maybePeerInfo.superordinate.selector) === 0) {
        addNodeToHierarchy(node, maybePeerInfo.superordinate, maybePeerInfo.level)
        return maybePeerInfo.level
      } else {
        maybePeer = maybePeerInfo.superordinate
      }
    } else {
      maybePeer = false
    }
  }

  return nodeLevel
}
