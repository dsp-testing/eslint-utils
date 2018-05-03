import { getInnermostScope } from "./get-innermost-scope"
import { getPropertyName } from "./get-property-name"
import { getStringIfConstant } from "./get-string-if-constant"

const SENTINEL_TYPE = /^(?:.+?Statement|.+?Declaration|(?:Array|ArrowFunction|Assignment|Call|Class|Function|Member|New|Object)Expression|AssignmentPattern|Program|VariableDeclarator)$/
const IMPORT_TYPE = /^(?:Import|Export(?:All|Default|Named))Declaration$/
const has = Function.call.bind(Object.hasOwnProperty)

export const READ = Symbol("read")
export const CALL = Symbol("call")
export const CONSTRUCT = Symbol("construct")
export const ESM = Symbol("strict")

/**
 * The reference tracer.
 */
export class ReferenceTracer {
    /**
     * Initialize this tracer.
     * @param {Scope} globalScope The global scope.
     * @param {object} [options] The options.
     * @param {"legacy"|"strict"} [options.mode="strict"] The mode to determine the ImportDeclaration's behavior for CJS modules.
     * @param {string[]} [options.globalObjectNames=["global","self","window"]] The variable names for Global Object.
     */
    constructor(
        globalScope,
        {
            mode = "strict",
            globalObjectNames = ["global", "self", "window"],
        } = {}
    ) {
        this.variableStack = []
        this.globalScope = globalScope
        this.mode = mode
        this.globalObjectNames = globalObjectNames.slice(0)
    }

    /**
     * Iterate the references of global variables.
     * @param {object} traceMap The trace map.
     * @returns {IterableIterator<{node:Node,path:string[],type:symbol,entry:any}>} The iterator to iterate references.
     */
    *iterateGlobalReferences(traceMap) {
        for (const key of Object.keys(traceMap)) {
            const nextTraceMap = traceMap[key]
            const path = [key]
            const variable = this.globalScope.set.get(key)

            if (variable == null || variable.defs.length !== 0) {
                continue
            }

            yield* this._iterateVariableReferences(
                variable,
                path,
                nextTraceMap,
                true
            )
        }

        for (const key of this.globalObjectNames) {
            const path = []
            const variable = this.globalScope.set.get(key)

            if (variable == null || variable.defs.length !== 0) {
                continue
            }

            yield* this._iterateVariableReferences(
                variable,
                path,
                traceMap,
                false
            )
        }
    }

    /**
     * Iterate the references of CommonJS modules.
     * @param {object} traceMap The trace map.
     * @returns {IterableIterator<{node:Node,path:string[],type:symbol,entry:any}>} The iterator to iterate references.
     */
    *iterateCjsReferences(traceMap) {
        const variable = this.globalScope.set.get("require")

        if (variable == null || variable.defs.length !== 0) {
            return
        }

        for (const reference of variable.references) {
            const reqNode = reference.identifier
            const callNode = reqNode.parent

            if (
                !reference.isRead() ||
                callNode.type !== "CallExpression" ||
                callNode.callee !== reqNode
            ) {
                continue
            }
            const key = getStringIfConstant(callNode.arguments[0])

            if (key == null || !has(traceMap, key)) {
                continue
            }
            const nextTraceMap = traceMap[key]
            const path = [key]

            if (nextTraceMap[READ]) {
                yield {
                    node: callNode,
                    path,
                    type: READ,
                    entry: nextTraceMap[READ],
                }
            }
            yield* this._iteratePropertyReferences(callNode, path, nextTraceMap)
        }
    }

    /**
     * Iterate the references of ES modules.
     * @param {object} traceMap The trace map.
     * @returns {IterableIterator<{node:Node,path:string[],type:symbol,entry:any}>} The iterator to iterate references.
     */
    *iterateEsmReferences(traceMap) {
        const programNode = this.globalScope.block

        for (const node of programNode.body) {
            if (!IMPORT_TYPE.test(node.type) || node.source == null) {
                continue
            }
            const moduleId = node.source.value

            if (!has(traceMap, moduleId)) {
                continue
            }
            const nextTraceMap = traceMap[moduleId]
            const path = [moduleId]

            if (nextTraceMap[READ]) {
                yield { node, path, type: READ, entry: nextTraceMap[READ] }
            }

            if (node.type === "ExportAllDeclaration") {
                for (const key of Object.keys(nextTraceMap)) {
                    const exportTraceMap = nextTraceMap[key]
                    if (exportTraceMap[READ]) {
                        yield {
                            node,
                            path: path.concat(key),
                            type: READ,
                            entry: exportTraceMap[READ],
                        }
                    }
                }
            } else {
                for (const specifier of node.specifiers) {
                    const esm = has(nextTraceMap, ESM)
                    const it = this._iterateImportReferences(
                        specifier,
                        path,
                        esm
                            ? nextTraceMap
                            : this.mode === "legacy"
                                ? Object.assign(
                                      { default: nextTraceMap },
                                      nextTraceMap
                                  )
                                : { default: nextTraceMap }
                    )

                    if (esm) {
                        yield* it
                    } else {
                        for (const report of it) {
                            report.path = report.path.filter(exceptDefault)
                            if (
                                report.path.length >= 2 ||
                                report.type !== READ
                            ) {
                                yield report
                            }
                        }
                    }
                }
            }
        }
    }

    /**
     * Finds the variable object of a given Identifier node.
     * @param {ASTNode} node - An Identifier node to find.
     * @returns {Variable|null} Found variable object.
     */
    _findVariable(node) {
        let scope = getInnermostScope(this.globalScope, node)
        while (scope != null) {
            const variable = scope.set.get(node.name)
            if (variable != null) {
                return variable
            }

            scope = scope.upper
        }

        return null
    }

    /**
     * Iterate the references for a given variable.
     * @param {Variable} variable The variable to iterate that references.
     * @param {string[]} path The current path.
     * @param {object} traceMap The trace map.
     * @param {boolean} shouldReport = The flag to report those references.
     * @returns {IterableIterator<{node:Node,path:string[],type:symbol,entry:any}>} The iterator to iterate references.
     */
    *_iterateVariableReferences(variable, path, traceMap, shouldReport) {
        if (this.variableStack.includes(variable)) {
            return
        }
        this.variableStack.push(variable)
        try {
            for (const reference of variable.references) {
                if (!reference.isRead()) {
                    continue
                }
                const node = reference.identifier

                if (shouldReport && traceMap[READ]) {
                    yield { node, path, type: READ, entry: traceMap[READ] }
                }
                yield* this._iteratePropertyReferences(node, path, traceMap)
            }
        } finally {
            this.variableStack.pop()
        }
    }

    /**
     * Iterate the references for a given AST node.
     * @param rootNode The AST node to iterate references.
     * @param {string[]} path The current path.
     * @param {object} traceMap The trace map.
     * @returns {IterableIterator<{node:Node,path:string[],type:symbol,entry:any}>} The iterator to iterate references.
     */
    //eslint-disable-next-line complexity, require-jsdoc
    *_iteratePropertyReferences(rootNode, path, traceMap) {
        let node = rootNode
        while (!SENTINEL_TYPE.test(node.parent.type)) {
            node = node.parent
        }

        const parent = node.parent
        if (parent.type === "MemberExpression") {
            if (parent.object === node) {
                const key = getPropertyName(parent)
                if (key == null || !has(traceMap, key)) {
                    return
                }

                path = path.concat(key) //eslint-disable-line no-param-reassign
                const nextTraceMap = traceMap[key]
                if (nextTraceMap[READ]) {
                    yield {
                        node: parent,
                        path,
                        type: READ,
                        entry: nextTraceMap[READ],
                    }
                }
                yield* this._iteratePropertyReferences(
                    parent,
                    path,
                    nextTraceMap
                )
            }
            return
        }
        if (parent.type === "CallExpression") {
            if (parent.callee === node && traceMap[CALL]) {
                yield { node: parent, path, type: CALL, entry: traceMap[CALL] }
            }
            return
        }
        if (parent.type === "NewExpression") {
            if (parent.callee === node && traceMap[CONSTRUCT]) {
                yield {
                    node: parent,
                    path,
                    type: CONSTRUCT,
                    entry: traceMap[CONSTRUCT],
                }
            }
            return
        }
        if (parent.type === "AssignmentExpression") {
            if (parent.right === node) {
                yield* this._iterateLhsReferences(parent.left, path, traceMap)
                yield* this._iteratePropertyReferences(parent, path, traceMap)
            }
            return
        }
        if (parent.type === "AssignmentPattern") {
            if (parent.right === node) {
                yield* this._iterateLhsReferences(parent.left, path, traceMap)
            }
            return
        }
        if (parent.type === "VariableDeclarator") {
            if (parent.init === node) {
                yield* this._iterateLhsReferences(parent.id, path, traceMap)
            }
        }
    }

    /**
     * Iterate the references for a given Pattern node.
     * @param {Node} patternNode The Pattern node to iterate references.
     * @param {string[]} path The current path.
     * @param {object} traceMap The trace map.
     * @returns {IterableIterator<{node:Node,path:string[],type:symbol,entry:any}>} The iterator to iterate references.
     */
    *_iterateLhsReferences(patternNode, path, traceMap) {
        if (patternNode.type === "Identifier") {
            const variable = this._findVariable(patternNode)
            if (variable != null) {
                yield* this._iterateVariableReferences(
                    variable,
                    path,
                    traceMap,
                    false
                )
            }
            return
        }
        if (patternNode.type === "ObjectPattern") {
            for (const property of patternNode.properties) {
                const key = getPropertyName(property)

                if (key == null || !has(traceMap, key)) {
                    continue
                }

                const nextPath = path.concat(key)
                const nextTraceMap = traceMap[key]
                if (nextTraceMap[READ]) {
                    yield {
                        node: property,
                        path: nextPath,
                        type: READ,
                        entry: nextTraceMap[READ],
                    }
                }
                yield* this._iterateLhsReferences(
                    property.value,
                    nextPath,
                    nextTraceMap
                )
            }
            return
        }
        if (patternNode.type === "AssignmentPattern") {
            yield* this._iterateLhsReferences(patternNode.left, path, traceMap)
        }
    }

    /**
     * Iterate the references for a given ModuleSpecifier node.
     * @param {Node} specifierNode The ModuleSpecifier node to iterate references.
     * @param {string[]} path The current path.
     * @param {object} traceMap The trace map.
     * @returns {IterableIterator<{node:Node,path:string[],type:symbol,entry:any}>} The iterator to iterate references.
     */
    *_iterateImportReferences(specifierNode, path, traceMap) {
        const type = specifierNode.type

        if (type === "ImportSpecifier" || type === "ImportDefaultSpecifier") {
            const key =
                type === "ImportDefaultSpecifier"
                    ? "default"
                    : specifierNode.imported.name
            if (!has(traceMap, key)) {
                return
            }

            path = path.concat(key) //eslint-disable-line no-param-reassign
            const nextTraceMap = traceMap[key]
            if (nextTraceMap[READ]) {
                yield {
                    node: specifierNode,
                    path,
                    type: READ,
                    entry: nextTraceMap[READ],
                }
            }
            yield* this._iterateVariableReferences(
                this._findVariable(specifierNode.local),
                path,
                nextTraceMap,
                false
            )

            return
        }

        if (type === "ImportNamespaceSpecifier") {
            yield* this._iterateVariableReferences(
                this._findVariable(specifierNode.local),
                path,
                traceMap,
                false
            )
            return
        }

        if (type === "ExportSpecifier") {
            const key = specifierNode.local.name
            if (!has(traceMap, key)) {
                return
            }

            path = path.concat(key) //eslint-disable-line no-param-reassign
            const nextTraceMap = traceMap[key]
            if (nextTraceMap[READ]) {
                yield {
                    node: specifierNode,
                    path,
                    type: READ,
                    entry: nextTraceMap[READ],
                }
            }
        }
    }
}

ReferenceTracer.READ = READ
ReferenceTracer.CALL = CALL
ReferenceTracer.CONSTRUCT = CONSTRUCT
ReferenceTracer.ESM = ESM

/**
 * This is a predicate function for Array#filter.
 * @param {string} name A name part.
 * @param {number} index The index of the name.
 * @returns {boolean} `false` if it's default.
 */
function exceptDefault(name, index) {
    return !(index === 1 && name === "default")
}
