/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LatexCompilerTool } from './latex-compiler.js';
import { Config } from '../config/config.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('LatexCompilerTool', () => {
  let tool: LatexCompilerTool;
  let mockConfig: any;
  let tempDir: string;

  beforeEach(() => {
    // Create a temporary directory for testing
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-test-'));
    
    mockConfig = {
      getTargetDir: vi.fn().mockReturnValue(tempDir),
      getFileService: vi.fn().mockReturnValue({
        shouldGeminiIgnoreFile: vi.fn().mockReturnValue(false),
      }),
      getDebugMode: vi.fn().mockReturnValue(false),
      getSummarizeToolOutputConfig: vi.fn().mockReturnValue(null),
      getGeminiClient: vi.fn().mockReturnValue(null),
    } as any;

    tool = new LatexCompilerTool(mockConfig);
  });

  afterEach(() => {
    // Clean up temporary directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('validateToolParams', () => {
    it('should accept valid LaTeX file path', () => {
      const latexFile = path.join(tempDir, 'test.tex');
      fs.writeFileSync(latexFile, '\\documentclass{article}\\begin{document}Hello World\\end{document}');

      const result = tool.validateToolParams({
        absolute_path: latexFile,
      });

      expect(result).toBeNull();
    });

    it('should reject relative paths', () => {
      const result = tool.validateToolParams({
        absolute_path: 'test.tex',
      });

      expect(result).toContain('File path must be absolute');
    });

    it('should reject non-LaTeX files', () => {
      const txtFile = path.join(tempDir, 'test.txt');
      fs.writeFileSync(txtFile, 'Not LaTeX');

      const result = tool.validateToolParams({
        absolute_path: txtFile,
      });

      expect(result).toContain('File must have a LaTeX extension');
    });

    it('should reject non-existent files', () => {
      const result = tool.validateToolParams({
        absolute_path: path.join(tempDir, 'nonexistent.tex'),
      });

      expect(result).toContain('LaTeX file does not exist');
    });

    it('should reject files outside root directory', () => {
      const outsideFile = path.join(os.tmpdir(), 'outside.tex');
      fs.writeFileSync(outsideFile, '\\documentclass{article}\\begin{document}Test\\end{document}');

      const result = tool.validateToolParams({
        absolute_path: outsideFile,
      });

      expect(result).toContain('File path must be within the root directory');

      // Clean up
      fs.unlinkSync(outsideFile);
    });

    it('should reject invalid number of passes', () => {
      const latexFile = path.join(tempDir, 'test.tex');
      fs.writeFileSync(latexFile, '\\documentclass{article}\\begin{document}Hello World\\end{document}');

      const result = tool.validateToolParams({
        absolute_path: latexFile,
        passes: 10,
      });

      expect(result).toContain('Number of passes must be between 1 and 5');
    });

    it('should reject absolute output directory', () => {
      const latexFile = path.join(tempDir, 'test.tex');
      fs.writeFileSync(latexFile, '\\documentclass{article}\\begin{document}Hello World\\end{document}');

      const result = tool.validateToolParams({
        absolute_path: latexFile,
        output_dir: '/absolute/path',
      });

      expect(result).toContain('Output directory must be relative to the project root directory');
    });

    it('should reject non-existent output directory', () => {
      const latexFile = path.join(tempDir, 'test.tex');
      fs.writeFileSync(latexFile, '\\documentclass{article}\\begin{document}Hello World\\end{document}');

      const result = tool.validateToolParams({
        absolute_path: latexFile,
        output_dir: 'nonexistent',
      });

      expect(result).toContain('Output directory must exist');
    });
  });

  describe('getDescription', () => {
    it('should generate basic description', () => {
      const latexFile = path.join(tempDir, 'test.tex');
      const result = tool.getDescription({
        absolute_path: latexFile,
      });

      expect(result).toContain('Compile');
      expect(result).toContain('test.tex');
      expect(result).toContain('pdflatex');
      expect(result).toContain('pdf');
    });

    it('should include passes in description', () => {
      const latexFile = path.join(tempDir, 'test.tex');
      const result = tool.getDescription({
        absolute_path: latexFile,
        passes: 3,
      });

      expect(result).toContain('(3 passes)');
    });

    it('should include bibtex in description', () => {
      const latexFile = path.join(tempDir, 'test.tex');
      const result = tool.getDescription({
        absolute_path: latexFile,
        run_bibtex: true,
      });

      expect(result).toContain('+ bibtex');
    });

    it('should include makeindex in description', () => {
      const latexFile = path.join(tempDir, 'test.tex');
      const result = tool.getDescription({
        absolute_path: latexFile,
        run_makeindex: true,
      });

      expect(result).toContain('+ makeindex');
    });

    it('should include custom description', () => {
      const latexFile = path.join(tempDir, 'test.tex');
      const result = tool.getDescription({
        absolute_path: latexFile,
        description: 'Custom task',
      });

      expect(result).toContain('(Custom task)');
    });
  });

  describe('tool properties', () => {
    it('should have correct tool properties', () => {
      expect(tool.name).toBe('compile_latex');
      expect(tool.displayName).toBe('LaTeX Compiler');
      expect(tool.description).toContain('Compiles LaTeX documents');
      expect(tool.isOutputMarkdown).toBe(false);
      expect(tool.canUpdateOutput).toBe(true);
    });

    it('should have correct schema', () => {
      expect(tool.schema.name).toBe('compile_latex');
      expect(tool.schema.parameters?.required).toContain('absolute_path');
      expect(tool.schema.parameters?.properties?.absolute_path).toBeDefined();
      expect(tool.schema.parameters?.properties?.compiler).toBeDefined();
      expect(tool.schema.parameters?.properties?.output_format).toBeDefined();
    });
  });
});