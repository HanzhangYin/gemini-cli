/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import { execSync } from 'child_process';
import { BaseTool, ToolResult, Icon } from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { isWithinRoot } from '../utils/fileUtils.js';
import { Config } from '../config/config.js';
import { getErrorMessage } from '../utils/errors.js';

/**
 * Represents a mathematical statement with its proof
 */
export interface ProofResult {
  /** Type of theorem environment (theorem, lemma, corollary, etc.) */
  type: string;
  /** Optional name/title of the theorem */
  name?: string;
  /** Optional label for referencing */
  label?: string;
  /** The theorem statement content */
  statement: string;
  /** The proof content if found */
  proof?: string;
  /** File path where the theorem was found */
  filePath: string;
  /** Line number where the theorem starts */
  lineNumber: number;
  /** Line number where the theorem ends */
  endLineNumber: number;
  /** Line number where the proof starts (if found) */
  proofStartLine?: number;
  /** Line number where the proof ends (if found) */
  proofEndLine?: number;
  /** Raw LaTeX content of the theorem */
  rawContent: string;
  /** Raw LaTeX content of the proof (if found) */
  rawProofContent?: string;
  /** Whether a proof was found */
  hasProof: boolean;
}

/**
 * Parameters for the GetProof tool
 */
export interface GetProofParams {
  /** The absolute path to the LaTeX file to analyze */
  absolute_path: string;
  /** The name, label, or description of the theorem to find */
  theorem_identifier: string;
  /** Optional: specific theorem types to search (theorem, lemma, corollary, etc.) */
  theorem_types?: string[];
  /** Optional: whether to use fuzzy matching for theorem identification */
  fuzzy_match?: boolean;
}

/**
 * Result of proof extraction
 */
export interface GetProofResult {
  /** The found theorem and its proof */
  result?: ProofResult;
  /** Whether the theorem was found */
  found: boolean;
  /** Error message if theorem not found */
  error?: string;
  /** All potential matches found during search */
  potentialMatches: ProofResult[];
}

/**
 * Tool for finding and extracting proofs of specific theorems from LaTeX documents
 */
export class GetProofTool extends BaseTool<GetProofParams, ToolResult> {
  static readonly Name = 'get_proof';

  constructor(private config: Config) {
    super(
      GetProofTool.Name,
      'GetProof',
      'Finds and extracts the proof of a specific theorem, lemma, proposition, or corollary from LaTeX documents. Searches by name, label, or content description.',
      Icon.FileSearch,
      {
        properties: {
          absolute_path: {
            description: 'The absolute path to the LaTeX file to analyze',
            type: Type.STRING,
          },
          theorem_identifier: {
            description: 'The name, label, or description of the theorem to find (e.g., "Fundamental Theorem", "thm:main", or key words from the statement)',
            type: Type.STRING,
          },
          theorem_types: {
            description: 'Optional: Array of theorem types to search within (e.g., ["theorem", "lemma", "corollary"]). If not specified, searches all theorem-like environments.',
            type: Type.ARRAY,
            items: {
              type: Type.STRING,
            },
          },
          fuzzy_match: {
            description: 'Optional: Whether to use fuzzy matching for theorem identification (default: true)',
            type: Type.BOOLEAN,
          },
        },
        required: ['absolute_path', 'theorem_identifier'],
        type: Type.OBJECT,
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  validateToolParams(params: GetProofParams): string | null {
    const errors = SchemaValidator.validate(this.schema.parameters, params);
    if (errors) {
      return errors;
    }

    const filePath = params.absolute_path;
    if (!path.isAbsolute(filePath)) {
      return `File path must be absolute, but was relative: ${filePath}`;
    }

    if (!isWithinRoot(filePath, this.config.getTargetDir())) {
      return `File path must be within the root directory (${this.config.getTargetDir()}): ${filePath}`;
    }

    // Check if file has LaTeX extension
    const ext = path.extname(filePath).toLowerCase();
    if (!['.tex', '.latex'].includes(ext)) {
      return `File must have a LaTeX extension (.tex or .latex), but got: ${ext}`;
    }

    if (!params.theorem_identifier || params.theorem_identifier.trim().length === 0) {
      return 'Theorem identifier cannot be empty';
    }

    const fileService = this.config.getFileService();
    if (fileService.shouldGeminiIgnoreFile(params.absolute_path)) {
      return `File path '${filePath}' is ignored by .geminiignore pattern(s).`;
    }

    return null;
  }

  getDescription(params: GetProofParams): string {
    if (!params || typeof params.absolute_path !== 'string') {
      return 'Get proof from LaTeX file';
    }
    const relativePath = makeRelative(params.absolute_path, this.config.getTargetDir());
    const identifier = params.theorem_identifier || 'theorem';
    return `Get proof of "${identifier}" from ${shortenPath(relativePath)}`;
  }

  async execute(params: GetProofParams, signal: AbortSignal): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: Invalid parameters. ${validationError}`,
        returnDisplay: validationError,
      };
    }

    try {
      // Read the LaTeX file using cat command
      let fileContent: string;
      try {
        fileContent = execSync(`cat "${params.absolute_path}"`, {
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024, // 10MB max buffer
        });
      } catch (catError) {
        const errorMessage = getErrorMessage(catError);
        return {
          llmContent: `Error reading file with cat: ${errorMessage}`,
          returnDisplay: `Error: Could not read file - ${errorMessage}`,
        };
      }

      // Find the proof
      const proofResult = await this.findProof(
        fileContent,
        params.absolute_path,
        params,
        signal,
      );

      // Format the result
      const relativePath = makeRelative(params.absolute_path, this.config.getTargetDir());
      let llmContent = `# Proof Search Results\n\n`;
      llmContent += `**File:** ${relativePath}\n`;
      llmContent += `**Search Query:** "${params.theorem_identifier}"\n`;
      llmContent += `**Found:** ${proofResult.found ? 'Yes' : 'No'}\n\n`;

      if (!proofResult.found) {
        llmContent += `## No Matching Theorem Found\n\n`;
        if (proofResult.error) {
          llmContent += `**Error:** ${proofResult.error}\n\n`;
        }
        
        if (proofResult.potentialMatches.length > 0) {
          llmContent += `## Potential Matches\n\n`;
          llmContent += `Found ${proofResult.potentialMatches.length} theorem(s) that might be related:\n\n`;
          
          for (let i = 0; i < proofResult.potentialMatches.length; i++) {
            const match = proofResult.potentialMatches[i];
            llmContent += `### ${i + 1}. ${match.type.charAt(0).toUpperCase() + match.type.slice(1)}`;
            if (match.name) {
              llmContent += ` (${match.name})`;
            }
            llmContent += `\n\n`;
            
            llmContent += `**Location:** Lines ${match.lineNumber}-${match.endLineNumber}\n`;
            if (match.label) {
              llmContent += `**Label:** ${match.label}\n`;
            }
            llmContent += `**Statement:** ${match.statement.substring(0, 200)}${match.statement.length > 200 ? '...' : ''}\n`;
            llmContent += `**Has Proof:** ${match.hasProof ? 'Yes' : 'No'}\n\n`;
          }
        }
        
        const displaySummary = `No theorem found matching "${params.theorem_identifier}"`;
        return {
          llmContent,
          returnDisplay: displaySummary,
        };
      }

      // Found the theorem
      const result = proofResult.result!;
      llmContent += `## Found Theorem\n\n`;
      llmContent += `### ${result.type.charAt(0).toUpperCase() + result.type.slice(1)}`;
      if (result.name) {
        llmContent += ` (${result.name})`;
      }
      llmContent += `\n\n`;
      
      llmContent += `**Location:** Lines ${result.lineNumber}-${result.endLineNumber}\n`;
      if (result.label) {
        llmContent += `**Label:** ${result.label}\n`;
      }
      llmContent += `**Has Proof:** ${result.hasProof ? 'Yes' : 'No'}\n\n`;
      
      llmContent += `**Statement:**\n${result.statement}\n\n`;
      
      if (result.hasProof && result.proof) {
        llmContent += `## Proof\n\n`;
        if (result.proofStartLine && result.proofEndLine) {
          llmContent += `**Proof Location:** Lines ${result.proofStartLine}-${result.proofEndLine}\n\n`;
        }
        llmContent += `${result.proof}\n\n`;
        
        llmContent += `**Complete LaTeX:**\n\`\`\`latex\n${result.rawContent}`;
        if (result.rawProofContent) {
          llmContent += `\n\n${result.rawProofContent}`;
        }
        llmContent += `\n\`\`\`\n\n`;
      } else {
        llmContent += `## No Proof Found\n\n`;
        llmContent += `The theorem was found but no corresponding proof environment was detected.\n\n`;
        llmContent += `**Theorem LaTeX:**\n\`\`\`latex\n${result.rawContent}\n\`\`\`\n\n`;
      }

      const displaySummary = result.hasProof 
        ? `Found theorem "${params.theorem_identifier}" with proof` 
        : `Found theorem "${params.theorem_identifier}" but no proof`;

      return {
        llmContent,
        returnDisplay: displaySummary,
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      return {
        llmContent: `Error finding proof: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
      };
    }
  }

  private async findProof(
    content: string,
    filePath: string,
    params: GetProofParams,
    signal: AbortSignal,
  ): Promise<GetProofResult> {
    // Default theorem types if not specified
    const theoremTypes = params.theorem_types || [
      'theorem', 'lemma', 'corollary', 'proposition', 'definition',
      'example', 'remark', 'conjecture', 'axiom'
    ];

    // Extract all theorem-like environments first
    const theorems = await this.extractAllTheorems(content, filePath, theoremTypes, signal);
    
    // Find the best match for the identifier
    const fuzzyMatch = params.fuzzy_match !== false;
    const bestMatch = this.findBestMatch(theorems, params.theorem_identifier, fuzzyMatch);
    
    if (!bestMatch) {
      return {
        found: false,
        error: `No theorem found matching "${params.theorem_identifier}"`,
        potentialMatches: theorems.slice(0, 5), // Return top 5 potential matches
      };
    }

    // Look for proof environment following the theorem
    const proofContent = this.findProofForTheorem(content, bestMatch);
    bestMatch.proof = proofContent.proof;
    bestMatch.rawProofContent = proofContent.rawProofContent;
    bestMatch.proofStartLine = proofContent.proofStartLine;
    bestMatch.proofEndLine = proofContent.proofEndLine;
    bestMatch.hasProof = !!proofContent.proof;

    return {
      result: bestMatch,
      found: true,
      potentialMatches: [],
    };
  }

  private async extractAllTheorems(
    content: string,
    filePath: string,
    theoremTypes: string[],
    signal: AbortSignal,
  ): Promise<ProofResult[]> {
    const theorems: ProofResult[] = [];
    
    // Create regex patterns for theorem environments
    const beginPattern = new RegExp(
      `\\\\begin\\{(${theoremTypes.join('|')})\\}(?:\\[(.*?)\\])?(?:\\{(.*?)\\})?`,
      'gi'
    );
    const endPattern = /\\end\{([^}]+)\}/gi;

    let match;
    const theoremStack: Array<{
      type: string;
      name?: string;
      label?: string;
      startLine: number;
      startIndex: number;
    }> = [];

    // First pass: find all theorem environments
    while ((match = beginPattern.exec(content)) !== null) {
      if (signal.aborted) {
        throw new Error('Proof extraction was aborted');
      }

      const [fullMatch, type, name, label] = match;
      const startIndex = match.index;
      const startLine = this.getLineNumber(content, startIndex);

      theoremStack.push({
        type: type.toLowerCase(),
        name,
        label,
        startLine,
        startIndex,
      });
    }

    // Second pass: find matching end environments
    beginPattern.lastIndex = 0; // Reset regex
    let currentTheorem = 0;
    
    while ((match = endPattern.exec(content)) !== null) {
      if (signal.aborted) {
        throw new Error('Proof extraction was aborted');
      }

      const [fullMatch, endType] = match;
      const endIndex = match.index;
      const endLine = this.getLineNumber(content, endIndex);

      // Find matching theorem start
      for (let i = currentTheorem; i < theoremStack.length; i++) {
        const theorem = theoremStack[i];
        if (theorem.type === endType.toLowerCase()) {
          const rawContent = content.substring(theorem.startIndex, endIndex + fullMatch.length);
          const statement = this.extractStatement(rawContent);
          
          // Extract label from the theorem content if not already found
          let label = theorem.label;
          if (!label) {
            const labelMatch = rawContent.match(/\\label\{([^}]+)\}/);
            if (labelMatch) {
              label = labelMatch[1];
            }
          }
          
          const theoremObj: ProofResult = {
            type: theorem.type,
            name: theorem.name,
            label,
            statement,
            filePath,
            lineNumber: theorem.startLine,
            endLineNumber: endLine,
            rawContent,
            hasProof: false,
          };

          theorems.push(theoremObj);
          currentTheorem = i + 1;
          break;
        }
      }
    }

    return theorems;
  }

  private findBestMatch(theorems: ProofResult[], identifier: string, fuzzyMatch: boolean): ProofResult | null {
    const query = identifier.toLowerCase().trim();
    let bestMatch: ProofResult | null = null;
    let bestScore = 0;

    for (const theorem of theorems) {
      let score = 0;

      // Exact label match gets highest score
      if (theorem.label && theorem.label.toLowerCase() === query) {
        return theorem;
      }

      // Exact name match gets very high score
      if (theorem.name && theorem.name.toLowerCase() === query) {
        score = 100;
      }

      // Label contains query
      if (theorem.label && theorem.label.toLowerCase().includes(query)) {
        score = Math.max(score, 80);
      }

      // Name contains query
      if (theorem.name && theorem.name.toLowerCase().includes(query)) {
        score = Math.max(score, 70);
      }

      // Statement contains query (fuzzy matching)
      if (fuzzyMatch) {
        const statementLower = theorem.statement.toLowerCase();
        const words = query.split(/\s+/);
        let wordMatches = 0;
        
        for (const word of words) {
          if (word.length > 2 && statementLower.includes(word)) {
            wordMatches++;
          }
        }
        
        if (wordMatches > 0) {
          score = Math.max(score, (wordMatches / words.length) * 60);
        }
      }

      // Type matches query
      if (theorem.type.toLowerCase().includes(query)) {
        score = Math.max(score, 40);
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = theorem;
      }
    }

    // Only return match if score is above threshold
    return bestScore > 30 ? bestMatch : null;
  }

  private findProofForTheorem(content: string, theorem: ProofResult): {
    proof?: string;
    rawProofContent?: string;
    proofStartLine?: number;
    proofEndLine?: number;
  } {
    // Look for proof environment after the theorem
    const theoremEndIndex = content.indexOf(theorem.rawContent) + theorem.rawContent.length;
    const remainingContent = content.substring(theoremEndIndex);
    
    // Find proof environment
    const proofBeginMatch = remainingContent.match(/\\begin\{proof\}(?:\[[^\]]*\])?/i);
    if (!proofBeginMatch) {
      return {};
    }

    const proofStartIndex = theoremEndIndex + proofBeginMatch.index!;
    const proofStartLine = this.getLineNumber(content, proofStartIndex);
    
    // Find matching end
    const proofContent = content.substring(proofStartIndex);
    const proofEndMatch = proofContent.match(/\\end\{proof\}/i);
    if (!proofEndMatch) {
      return {};
    }

    const proofEndIndex = proofStartIndex + proofEndMatch.index! + proofEndMatch[0].length;
    const proofEndLine = this.getLineNumber(content, proofEndIndex);
    
    const rawProofContent = content.substring(proofStartIndex, proofEndIndex);
    const proof = this.extractProofStatement(rawProofContent);

    return {
      proof,
      rawProofContent,
      proofStartLine,
      proofEndLine,
    };
  }

  private extractProofStatement(rawProofContent: string): string {
    // Remove begin/end tags and extract the proof content
    const beginMatch = rawProofContent.match(/\\begin\{proof\}(?:\[[^\]]*\])?/i);
    const endMatch = rawProofContent.match(/\\end\{proof\}/i);
    
    if (!beginMatch || !endMatch) {
      return rawProofContent.trim();
    }

    const start = beginMatch.index! + beginMatch[0].length;
    const end = rawProofContent.lastIndexOf(endMatch[0]);
    
    let statement = rawProofContent.substring(start, end).trim();
    
    // Clean up common LaTeX commands but preserve structure
    statement = statement.replace(/^\s*\n+/gm, '');
    statement = statement.replace(/\s*\n+\s*$/gm, '');
    
    return statement;
  }

  private getLineNumber(content: string, index: number): number {
    return content.substring(0, index).split('\n').length;
  }

  private extractStatement(rawContent: string): string {
    // Remove begin/end tags and extract the theorem statement
    const beginMatch = rawContent.match(/\\begin\{[^}]+\}(?:\[[^\]]*\])?(?:\{[^}]*\})?/);
    const endMatch = rawContent.match(/\\end\{[^}]+\}/);
    
    if (!beginMatch || !endMatch) {
      return rawContent.trim();
    }

    const start = beginMatch.index! + beginMatch[0].length;
    const end = rawContent.lastIndexOf(endMatch[0]);
    
    let statement = rawContent.substring(start, end).trim();
    
    // Clean up common LaTeX commands
    statement = statement.replace(/\\label\{[^}]*\}/g, '');
    statement = statement.replace(/^\s*\n+/gm, '');
    statement = statement.replace(/\s*\n+\s*$/gm, '');
    
    return statement;
  }
}