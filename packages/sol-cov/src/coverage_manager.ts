import { promisify } from '@0xproject/utils';
import { addHexPrefix } from 'ethereumjs-util';
import * as fs from 'fs';
import { Collector } from 'istanbul';
import * as _ from 'lodash';
import * as mkdirp from 'mkdirp';
import * as path from 'path';

import { collectContractsData } from './collect_contract_data';
import { collectCoverageEntries } from './collect_coverage_entries';
import { constants } from './constants';
import { parseSourceMap } from './source_maps';
import {
    BranchCoverage,
    BranchDescription,
    BranchMap,
    ContractData,
    Coverage,
    FnMap,
    FunctionCoverage,
    FunctionDescription,
    LineColumn,
    SingleFileSourceRange,
    SourceRange,
    StatementCoverage,
    StatementDescription,
    StatementMap,
    TraceInfo,
    TraceInfoExistingContract,
    TraceInfoNewContract,
} from './types';
import { utils } from './utils';

const mkdirpAsync = promisify<undefined>(mkdirp);

export class CoverageManager {
    private _sourcesPath: string;
    private _traceInfos: TraceInfo[] = [];
    private _contractsData: ContractData[] = [];
    private _getContractCodeAsync: (address: string) => Promise<string>;
    constructor(
        artifactsPath: string,
        sourcesPath: string,
        getContractCodeAsync: (address: string) => Promise<string>,
    ) {
        this._getContractCodeAsync = getContractCodeAsync;
        this._sourcesPath = sourcesPath;
        this._contractsData = collectContractsData(artifactsPath, this._sourcesPath);
    }
    public appendTraceInfo(traceInfo: TraceInfo): void {
        this._traceInfos.push(traceInfo);
    }
    public async writeCoverageAsync(): Promise<void> {
        const finalCoverage = await this._computeCoverageAsync();
        const stringifiedCoverage = JSON.stringify(finalCoverage, null, '\t');
        await mkdirpAsync('coverage');
        fs.writeFileSync('coverage/coverage.json', stringifiedCoverage);
    }
    private _getSingleFileCoverageForTrace(
        contractData: ContractData,
        coveredPcs: number[],
        pcToSourceRange: { [programCounter: number]: SourceRange },
        fileIndex: number,
    ): Coverage {
        const fileName = contractData.sources[fileIndex];
        const coverageEntriesDescription = collectCoverageEntries(contractData.sourceCodes[fileIndex]);
        let sourceRanges = _.map(coveredPcs, coveredPc => pcToSourceRange[coveredPc]);
        sourceRanges = _.compact(sourceRanges); // Some PC's don't map to a source range and we just ignore them.
        // By default lodash does a shallow object comparasion. We JSON.stringify them and compare as strings.
        sourceRanges = _.uniqBy(sourceRanges, s => JSON.stringify(s)); // We don't care if one PC was covered multiple times within a single transaction
        sourceRanges = _.filter(sourceRanges, sourceRange => sourceRange.fileName === fileName);
        const branchCoverage: BranchCoverage = {};
        const branchIds = _.keys(coverageEntriesDescription.branchMap);
        for (const branchId of branchIds) {
            const branchDescription = coverageEntriesDescription.branchMap[branchId];
            const isCoveredByBranchIndex = _.map(branchDescription.locations, location =>
                _.some(sourceRanges, range => utils.isRangeInside(range.location, location)),
            );
            branchCoverage[branchId] = isCoveredByBranchIndex;
        }
        const statementCoverage: StatementCoverage = {};
        const statementIds = _.keys(coverageEntriesDescription.statementMap);
        for (const statementId of statementIds) {
            const statementDescription = coverageEntriesDescription.statementMap[statementId];
            const isCovered = _.some(sourceRanges, range => utils.isRangeInside(range.location, statementDescription));
            statementCoverage[statementId] = isCovered;
        }
        const functionCoverage: FunctionCoverage = {};
        const functionIds = _.keys(coverageEntriesDescription.fnMap);
        for (const fnId of functionIds) {
            const functionDescription = coverageEntriesDescription.fnMap[fnId];
            const isCovered = _.some(sourceRanges, range =>
                utils.isRangeInside(range.location, functionDescription.loc),
            );
            functionCoverage[fnId] = isCovered;
        }
        // HACK: Solidity doesn't emit any opcodes that map back to modifiers with no args, that's why we map back to the
        // function range and check if there is any covered statement within that range.
        for (const modifierStatementId of coverageEntriesDescription.modifiersStatementIds) {
            if (statementCoverage[modifierStatementId]) {
                // Already detected as covered
                continue;
            }
            const modifierDescription = coverageEntriesDescription.statementMap[modifierStatementId];
            const enclosingFunction = _.find(coverageEntriesDescription.fnMap, functionDescription =>
                utils.isRangeInside(modifierDescription, functionDescription.loc),
            ) as FunctionDescription;
            const isModifierCovered = _.some(
                coverageEntriesDescription.statementMap,
                (statementDescription: StatementDescription, statementId: number) => {
                    const isInsideTheModifierEnclosingFunction = utils.isRangeInside(
                        statementDescription,
                        enclosingFunction.loc,
                    );
                    const isCovered = statementCoverage[statementId];
                    return isInsideTheModifierEnclosingFunction && isCovered;
                },
            );
            statementCoverage[modifierStatementId] = isModifierCovered;
        }
        const absoluteFileName = path.join(this._sourcesPath, fileName);
        const partialCoverage = {
            [absoluteFileName]: {
                ...coverageEntriesDescription,
                l: {}, // It's able to derive it from statement coverage
                path: absoluteFileName,
                f: functionCoverage,
                s: statementCoverage,
                b: branchCoverage,
            },
        };
        return partialCoverage;
    }
    private async _computeCoverageAsync(): Promise<Coverage> {
        const collector = new Collector();
        for (const traceInfo of this._traceInfos) {
            if (traceInfo.address !== constants.NEW_CONTRACT) {
                // Runtime transaction
                let runtimeBytecode = (traceInfo as TraceInfoExistingContract).runtimeBytecode;
                runtimeBytecode = addHexPrefix(runtimeBytecode);
                const contractData = _.find(this._contractsData, { runtimeBytecode }) as ContractData;
                if (_.isUndefined(contractData)) {
                    throw new Error(`Transaction to an unknown address: ${traceInfo.address}`);
                }
                const bytecodeHex = contractData.runtimeBytecode.slice(2);
                const sourceMap = contractData.sourceMapRuntime;
                const pcToSourceRange = parseSourceMap(
                    contractData.sourceCodes,
                    sourceMap,
                    bytecodeHex,
                    contractData.sources,
                );
                for (let fileIndex = 0; fileIndex < contractData.sources.length; fileIndex++) {
                    const singleFileCoverageForTrace = this._getSingleFileCoverageForTrace(
                        contractData,
                        traceInfo.coveredPcs,
                        pcToSourceRange,
                        fileIndex,
                    );
                    collector.add(singleFileCoverageForTrace);
                }
            } else {
                // Contract creation transaction
                let bytecode = (traceInfo as TraceInfoNewContract).bytecode;
                bytecode = addHexPrefix(bytecode);
                const contractData = _.find(this._contractsData, contractDataCandidate =>
                    bytecode.startsWith(contractDataCandidate.bytecode),
                ) as ContractData;
                if (_.isUndefined(contractData)) {
                    throw new Error(`Unknown contract creation transaction`);
                }
                const bytecodeHex = contractData.bytecode.slice(2);
                const sourceMap = contractData.sourceMap;
                const pcToSourceRange = parseSourceMap(
                    contractData.sourceCodes,
                    sourceMap,
                    bytecodeHex,
                    contractData.sources,
                );
                for (let fileIndex = 0; fileIndex < contractData.sources.length; fileIndex++) {
                    const singleFileCoverageForTrace = this._getSingleFileCoverageForTrace(
                        contractData,
                        traceInfo.coveredPcs,
                        pcToSourceRange,
                        fileIndex,
                    );
                    collector.add(singleFileCoverageForTrace);
                }
            }
        }
        return collector.getFinalCoverage();
    }
}
