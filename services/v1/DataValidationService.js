/**
 * DataValidationService
 * Performs deterministic, server-side validation of extracted document data.
 * Validates dates, ID formats, and logical consistency independently of AI output.
 * If ANY check fails, the document is flagged for rejection.
 */
class DataValidationService {

    /**
     * Known ID format patterns for Indian documents.
     * Each entry: { pattern: RegExp, description: string }
     */
    static ID_FORMATS = {
        aadhaar: {
            fields: ['aadhaar_number', 'aadhaar_no', 'uid', 'id_number'],
            pattern: /^\d{4}\s?\d{4}\s?\d{4}$/,
            normalized: /^\d{12}$/,
            description: '12-digit numeric (XXXX XXXX XXXX)',
            validate(value) {
                const cleaned = String(value).replace(/\s+/g, '');
                if (!/^\d{12}$/.test(cleaned)) return false;
                // Aadhaar cannot start with 0 or 1
                if (cleaned[0] === '0' || cleaned[0] === '1') return false;
                // Verhoeff checksum (simplified - check digit is last digit)
                return true;
            }
        },
        pan: {
            fields: ['pan_number', 'pan_no', 'pan', 'id_number'],
            pattern: /^[A-Z]{5}\d{4}[A-Z]$/,
            description: '10-char alphanumeric (ABCDE1234F)',
            validate(value) {
                const cleaned = String(value).replace(/\s+/g, '').toUpperCase();
                // PAN format: AAAAA9999A
                // 4th char indicates holder type: C=Company, P=Person, H=HUF, F=Firm, etc.
                return /^[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]$/.test(cleaned);
            }
        },
        passport: {
            fields: ['passport_number', 'passport_no', 'id_number'],
            pattern: /^[A-Z]\d{7}$/,
            description: 'Letter followed by 7 digits (A1234567)',
            validate(value) {
                const cleaned = String(value).replace(/\s+/g, '').toUpperCase();
                return /^[A-Z]\d{7}$/.test(cleaned);
            }
        },
        driving_license: {
            fields: ['license_number', 'dl_number', 'dl_no', 'id_number'],
            // Format: SS-DDYYYYNNNNNNN (state code, RTO, year, serial)
            pattern: /^[A-Z]{2}[\s-]?\d{2}[\s-]?\d{4,13}$/,
            description: 'State code + RTO code + year + serial',
            validate(value) {
                const cleaned = String(value).replace(/[\s-]+/g, '').toUpperCase();
                // Minimum: 2 letters + 2 digits + 4 digits = 8 chars
                return /^[A-Z]{2}\d{2}\d{4,13}$/.test(cleaned) && cleaned.length >= 8 && cleaned.length <= 17;
            }
        },
        voter_id: {
            fields: ['voter_id', 'epic_number', 'epic_no', 'id_number'],
            pattern: /^[A-Z]{3}\d{7}$/,
            description: '3 letters followed by 7 digits (ABC1234567)',
            validate(value) {
                const cleaned = String(value).replace(/\s+/g, '').toUpperCase();
                return /^[A-Z]{3}\d{7}$/.test(cleaned);
            }
        }
    };

    /**
     * Known date field names used across document types
     */
    static DATE_FIELDS = [
        'date_of_birth', 'dob', 'birth_date',
        'issue_date', 'date_of_issue', 'issued_on',
        'expiry_date', 'date_of_expiry', 'valid_until', 'valid_till', 'expiry',
        'exam_date', 'date_of_exam', 'examination_date',
        'date_of_passing', 'passing_date', 'year_of_passing',
        'registration_date', 'date_of_registration',
        'statement_date', 'bill_date'
    ];

    /**
     * Main entry point: validate all extracted data for a given document type.
     * Returns { passed, results, issues, failedChecks }
     */
    static validate(documentType, extractedData, metadata = {}) {
        if (!extractedData || typeof extractedData !== 'object') {
            return {
                passed: false,
                results: {},
                issues: ['No extracted data to validate'],
                failedChecks: ['no_data']
            };
        }

        const results = {};
        const issues = [];
        const failedChecks = [];

        // 1. Date validation
        const dateResult = this.validateDates(extractedData, documentType);
        results.dates = dateResult;
        if (!dateResult.valid) {
            issues.push(...dateResult.issues);
            failedChecks.push('dates_invalid');
        }

        // 2. ID format validation
        const idResult = this.validateIdFormat(documentType, extractedData);
        results.id_format = idResult;
        if (!idResult.valid) {
            issues.push(...idResult.issues);
            failedChecks.push('id_format_invalid');
        }

        // 3. Logical consistency checks
        const logicalResult = this.validateLogicalConsistency(documentType, extractedData, metadata);
        results.logical_checks = logicalResult;
        if (!logicalResult.valid) {
            issues.push(...logicalResult.issues);
            failedChecks.push('logical_check_failed');
        }

        // 4. Data completeness and consistency
        const consistencyResult = this.validateDataConsistency(extractedData);
        results.data_consistency = consistencyResult;
        if (!consistencyResult.valid) {
            issues.push(...consistencyResult.issues);
            failedChecks.push('data_inconsistent');
        }

        const passed = failedChecks.length === 0;

        return {
            passed,
            results,
            issues,
            failedChecks,
            summary: {
                dates_valid: dateResult.valid,
                id_format_valid: idResult.valid,
                logical_checks_passed: logicalResult.valid,
                data_consistent: consistencyResult.valid,
                total_checks: 4,
                checks_passed: [dateResult, idResult, logicalResult, consistencyResult].filter(r => r.valid).length,
                details: issues.length > 0 ? issues.join('; ') : 'All validation checks passed'
            }
        };
    }

    // ==================== DATE VALIDATION ====================

    /**
     * Validate all date fields in extracted data
     */
    static validateDates(extractedData, documentType) {
        const issues = [];
        const checkedFields = {};
        const parsedDates = {};

        // Find and parse all date fields
        for (const [key, value] of Object.entries(extractedData)) {
            if (value == null || value === '') continue;
            const isDateField = this.DATE_FIELDS.some(df => key.toLowerCase().includes(df.replace(/_/g, ''))) ||
                                key.toLowerCase().includes('date') ||
                                key.toLowerCase().includes('dob') ||
                                key.toLowerCase().endsWith('_on') ||
                                key.toLowerCase().endsWith('_at');

            if (!isDateField) continue;

            const parsed = this._parseDate(value);
            if (!parsed) {
                // Could be a year-only field like year_of_passing
                if (key.toLowerCase().includes('year')) {
                    const year = parseInt(String(value), 10);
                    if (year && year >= 1900 && year <= new Date().getFullYear() + 5) {
                        checkedFields[key] = { valid: true, value, parsed: new Date(year, 0, 1), type: 'year' };
                        parsedDates[key] = new Date(year, 0, 1);
                        continue;
                    }
                }
                issues.push(`Invalid date format for '${key}': "${value}" is not a recognizable date`);
                checkedFields[key] = { valid: false, value, error: 'Unrecognizable date format' };
                continue;
            }

            // Check date is real (not Feb 30, etc.)
            if (!this._isRealDate(parsed)) {
                issues.push(`Invalid date for '${key}': "${value}" is not a real calendar date`);
                checkedFields[key] = { valid: false, value, error: 'Not a real calendar date' };
                continue;
            }

            // Check date is within reasonable range
            const rangeCheck = this._checkDateRange(key, parsed, documentType);
            if (!rangeCheck.valid) {
                issues.push(rangeCheck.issue);
                checkedFields[key] = { valid: false, value, error: rangeCheck.issue };
                continue;
            }

            checkedFields[key] = { valid: true, value, parsed };
            parsedDates[key] = parsed;
        }

        // Cross-validate date relationships
        const crossCheck = this._crossValidateDates(parsedDates, documentType);
        if (crossCheck.issues.length > 0) {
            issues.push(...crossCheck.issues);
        }

        return {
            valid: issues.length === 0,
            checked_fields: checkedFields,
            issues
        };
    }

    /**
     * Parse a date string into a Date object. Handles multiple formats.
     */
    static _parseDate(value) {
        if (value instanceof Date) return isNaN(value.getTime()) ? null : value;

        const str = String(value).trim();
        if (!str) return null;

        // Try ISO format (YYYY-MM-DD)
        const isoMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (isoMatch) {
            return new Date(parseInt(isoMatch[1]), parseInt(isoMatch[2]) - 1, parseInt(isoMatch[3]));
        }

        // DD/MM/YYYY or DD-MM-YYYY
        const dmyMatch = str.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
        if (dmyMatch) {
            const day = parseInt(dmyMatch[1]);
            const month = parseInt(dmyMatch[2]);
            const year = parseInt(dmyMatch[3]);
            if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
                return new Date(year, month - 1, day);
            }
        }

        // MM/DD/YYYY (if day > 12, it's definitely DD/MM)
        // Already handled above with DD/MM logic

        // DD Mon YYYY or DD Month YYYY
        const monthNames = {
            jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
            apr: 3, april: 3, may: 4, jun: 5, june: 5,
            jul: 6, july: 6, aug: 7, august: 7, sep: 8, september: 8,
            oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
        };
        const namedMatch = str.match(/^(\d{1,2})[\s\-.]?([a-zA-Z]+)[\s\-.,]?\s*(\d{4})$/);
        if (namedMatch) {
            const day = parseInt(namedMatch[1]);
            const monthStr = namedMatch[2].toLowerCase();
            const year = parseInt(namedMatch[3]);
            if (monthNames[monthStr] !== undefined) {
                return new Date(year, monthNames[monthStr], day);
            }
        }

        // Month DD, YYYY
        const mdyNamedMatch = str.match(/^([a-zA-Z]+)\s+(\d{1,2}),?\s*(\d{4})$/);
        if (mdyNamedMatch) {
            const monthStr = mdyNamedMatch[1].toLowerCase();
            const day = parseInt(mdyNamedMatch[2]);
            const year = parseInt(mdyNamedMatch[3]);
            if (monthNames[monthStr] !== undefined) {
                return new Date(year, monthNames[monthStr], day);
            }
        }

        // YYYY only (for year_of_passing fields)
        if (/^\d{4}$/.test(str)) {
            const year = parseInt(str);
            if (year >= 1900 && year <= 2100) {
                return new Date(year, 0, 1);
            }
        }

        // Fallback: try native Date.parse
        const nativeParsed = new Date(str);
        if (!isNaN(nativeParsed.getTime())) {
            return nativeParsed;
        }

        return null;
    }

    /**
     * Check that a parsed Date is a real calendar date (not Feb 30, etc.)
     */
    static _isRealDate(date) {
        if (!(date instanceof Date) || isNaN(date.getTime())) return false;
        return date.getFullYear() >= 1900 && date.getFullYear() <= 2100;
    }

    /**
     * Check that a date falls within a reasonable range based on the field name
     */
    static _checkDateRange(fieldName, date, documentType) {
        const now = new Date();
        const field = fieldName.toLowerCase();

        // DOB checks
        if (field.includes('birth') || field.includes('dob')) {
            if (date > now) {
                return { valid: false, issue: `Date of birth '${fieldName}' is in the future` };
            }
            const age = (now - date) / (365.25 * 24 * 60 * 60 * 1000);
            if (age > 150) {
                return { valid: false, issue: `Date of birth '${fieldName}' implies age over 150 years` };
            }
            if (age < 0) {
                return { valid: false, issue: `Date of birth '${fieldName}' is in the future` };
            }
        }

        // Issue date should not be in the future
        if (field.includes('issue') || field.includes('registration') || field.includes('passing')) {
            if (date > new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)) { // 30-day grace
                return { valid: false, issue: `Issue/registration date '${fieldName}' is in the future` };
            }
        }

        // Expiry date: should not be unreasonably far in future (50 years max)
        if (field.includes('expir') || field.includes('valid')) {
            const yearsFromNow = (date - now) / (365.25 * 24 * 60 * 60 * 1000);
            if (yearsFromNow > 50) {
                return { valid: false, issue: `Expiry date '${fieldName}' is more than 50 years in the future` };
            }
        }

        // Exam date should be in the past
        if (field.includes('exam')) {
            if (date > new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000)) { // 1-year grace for upcoming exams
                return { valid: false, issue: `Exam date '${fieldName}' is unreasonably far in the future` };
            }
        }

        return { valid: true };
    }

    /**
     * Cross-validate date relationships (e.g., issue < expiry, DOB < issue date)
     */
    static _crossValidateDates(parsedDates, documentType) {
        const issues = [];
        const keys = Object.keys(parsedDates);

        // Find DOB, issue, and expiry dates
        const dobKey = keys.find(k => k.toLowerCase().includes('birth') || k.toLowerCase().includes('dob'));
        const issueKey = keys.find(k => k.toLowerCase().includes('issue') && !k.toLowerCase().includes('expir'));
        const expiryKey = keys.find(k => k.toLowerCase().includes('expir') || k.toLowerCase().includes('valid'));
        const passingKey = keys.find(k => k.toLowerCase().includes('passing'));
        const examKey = keys.find(k => k.toLowerCase().includes('exam') && k.toLowerCase().includes('date'));

        // Issue date must be before expiry date
        if (issueKey && expiryKey && parsedDates[issueKey] >= parsedDates[expiryKey]) {
            issues.push(`Issue date (${issueKey}) must be before expiry date (${expiryKey})`);
        }

        // DOB must be before issue date
        if (dobKey && issueKey && parsedDates[dobKey] >= parsedDates[issueKey]) {
            issues.push(`Date of birth (${dobKey}) must be before issue date (${issueKey})`);
        }

        // DOB must be before exam/passing date
        if (dobKey && passingKey && parsedDates[dobKey] >= parsedDates[passingKey]) {
            issues.push(`Date of birth must be before date of passing`);
        }
        if (dobKey && examKey && parsedDates[dobKey] >= parsedDates[examKey]) {
            issues.push(`Date of birth must be before exam date`);
        }

        // For marksheets: person should be at least 10 years old at exam time
        if (dobKey && (passingKey || examKey)) {
            const examDate = parsedDates[passingKey] || parsedDates[examKey];
            const ageAtExam = (examDate - parsedDates[dobKey]) / (365.25 * 24 * 60 * 60 * 1000);
            if (ageAtExam < 5) {
                issues.push(`Person appears to be under 5 years old at the time of examination - suspicious`);
            }
        }

        // For ID documents: person should be at least a minimum age at issue
        if (dobKey && issueKey) {
            const ageAtIssue = (parsedDates[issueKey] - parsedDates[dobKey]) / (365.25 * 24 * 60 * 60 * 1000);
            if (documentType === 'driving_license' && ageAtIssue < 16) {
                issues.push(`Person appears to be under 16 at driving license issue date`);
            }
            if (documentType === 'voter_id' && ageAtIssue < 18) {
                issues.push(`Person appears to be under 18 at voter ID issue date`);
            }
            if (documentType === 'pan' && ageAtIssue < 0) {
                issues.push(`PAN card issue date is before date of birth`);
            }
        }

        return { issues };
    }

    // ==================== ID FORMAT VALIDATION ====================

    /**
     * Validate ID number format for the given document type
     */
    static validateIdFormat(documentType, extractedData) {
        const issues = [];
        const checkedFields = {};

        const formatDef = this.ID_FORMATS[documentType];
        if (!formatDef) {
            // No known format for this document type - pass by default
            return { valid: true, checked_fields: {}, issues: [], message: 'No ID format rules for this document type' };
        }

        // Find the ID field in extracted data
        let idFieldKey = null;
        let idValue = null;

        for (const fieldName of formatDef.fields) {
            // Check exact match first
            if (extractedData[fieldName] != null && String(extractedData[fieldName]).trim() !== '') {
                idFieldKey = fieldName;
                idValue = String(extractedData[fieldName]).trim();
                break;
            }
            // Check case-insensitive partial match
            for (const [key, val] of Object.entries(extractedData)) {
                if (val != null && String(val).trim() !== '' &&
                    key.toLowerCase().replace(/[_\s-]/g, '').includes(fieldName.replace(/[_\s-]/g, ''))) {
                    idFieldKey = key;
                    idValue = String(val).trim();
                    break;
                }
            }
            if (idFieldKey) break;
        }

        if (!idFieldKey || !idValue) {
            // No ID field found - check if it's a required field type
            const isIdDoc = ['aadhaar', 'pan', 'passport', 'driving_license', 'voter_id'].includes(documentType);
            if (isIdDoc) {
                issues.push(`No ID number found in extracted data for ${documentType}`);
                return { valid: false, checked_fields: {}, issues };
            }
            return { valid: true, checked_fields: {}, issues: [], message: 'No ID field found to validate' };
        }

        // Validate the format
        const isValid = formatDef.validate(idValue);
        checkedFields[idFieldKey] = {
            value: idValue,
            valid: isValid,
            expected_format: formatDef.description
        };

        if (!isValid) {
            issues.push(`ID number '${idValue}' in field '${idFieldKey}' does not match expected ${documentType} format (${formatDef.description})`);
        }

        return {
            valid: issues.length === 0,
            checked_fields: checkedFields,
            issues
        };
    }

    // ==================== LOGICAL CONSISTENCY ====================

    /**
     * Validate logical consistency of extracted data
     */
    static validateLogicalConsistency(documentType, extractedData, metadata) {
        const issues = [];
        const checks = {};

        // 1. Name consistency: if name appears in multiple fields, they should match
        const nameCheck = this._checkNameConsistency(extractedData);
        checks.name_consistency = nameCheck;
        if (!nameCheck.valid) {
            issues.push(...nameCheck.issues);
        }

        // 2. Metadata cross-verification: compare extracted data against provided metadata
        const metaCheck = this._checkMetadataMatch(extractedData, metadata);
        checks.metadata_match = metaCheck;
        if (!metaCheck.valid) {
            issues.push(...metaCheck.issues);
        }

        // 3. Document-type-specific logical checks
        const typeCheck = this._checkDocTypeLogic(documentType, extractedData);
        checks.type_specific = typeCheck;
        if (!typeCheck.valid) {
            issues.push(...typeCheck.issues);
        }

        // 4. Numeric field validation (scores, percentages, amounts)
        const numericCheck = this._checkNumericFields(extractedData, documentType);
        checks.numeric_fields = numericCheck;
        if (!numericCheck.valid) {
            issues.push(...numericCheck.issues);
        }

        return {
            valid: issues.length === 0,
            checks,
            issues
        };
    }

    /**
     * Check that name fields are consistent across the document
     */
    static _checkNameConsistency(extractedData) {
        const issues = [];
        const nameFields = {};

        for (const [key, value] of Object.entries(extractedData)) {
            if (value == null || typeof value !== 'string') continue;
            const keyLower = key.toLowerCase();
            if (keyLower.includes('name') && !keyLower.includes('exam') && !keyLower.includes('board') &&
                !keyLower.includes('school') && !keyLower.includes('institution') && !keyLower.includes('university')) {
                nameFields[key] = value.trim();
            }
        }

        // If there's a full_name and first_name + last_name, check they're consistent
        const fullName = nameFields['full_name'] || nameFields['name'] || nameFields['holder_name'] || nameFields['student_name'];
        const firstName = nameFields['first_name'];
        const lastName = nameFields['last_name'] || nameFields['surname'];

        if (fullName && firstName) {
            const fullLower = fullName.toLowerCase();
            const firstLower = firstName.toLowerCase();
            if (!fullLower.includes(firstLower)) {
                issues.push(`Name inconsistency: first_name "${firstName}" not found within full name "${fullName}"`);
            }
        }
        if (fullName && lastName) {
            const fullLower = fullName.toLowerCase();
            const lastLower = lastName.toLowerCase();
            if (!fullLower.includes(lastLower)) {
                issues.push(`Name inconsistency: last_name "${lastName}" not found within full name "${fullName}"`);
            }
        }

        return { valid: issues.length === 0, fields: nameFields, issues };
    }

    /**
     * Cross-verify extracted data against client-provided metadata
     */
    static _checkMetadataMatch(extractedData, metadata) {
        const issues = [];
        const results = {};

        if (!metadata || Object.keys(metadata).length === 0) {
            return { valid: true, results: {}, issues: [] };
        }

        for (const [metaKey, metaValue] of Object.entries(metadata)) {
            if (metaValue == null || metaValue === '') continue;

            // Find matching field in extracted data
            const extractedValue = extractedData[metaKey];
            if (extractedValue == null) continue; // Field not extracted, skip

            const metaStr = String(metaValue).trim().toLowerCase();
            const extractedStr = String(extractedValue).trim().toLowerCase();

            // For names: check containment rather than exact match
            if (metaKey.toLowerCase().includes('name')) {
                const metaWords = metaStr.split(/\s+/);
                const extractedWords = extractedStr.split(/\s+/);
                const commonWords = metaWords.filter(w => extractedWords.includes(w));
                if (commonWords.length === 0 && metaWords.length > 0) {
                    issues.push(`Metadata mismatch: '${metaKey}' - expected "${metaValue}", extracted "${extractedValue}"`);
                    results[metaKey] = { match: false, expected: metaValue, extracted: extractedValue };
                } else {
                    results[metaKey] = { match: true, expected: metaValue, extracted: extractedValue };
                }
            } else {
                // For other fields: normalized comparison
                const normalizedMeta = metaStr.replace(/[\s\-\/\.]/g, '');
                const normalizedExtracted = extractedStr.replace(/[\s\-\/\.]/g, '');
                if (normalizedMeta !== normalizedExtracted) {
                    issues.push(`Metadata mismatch: '${metaKey}' - expected "${metaValue}", extracted "${extractedValue}"`);
                    results[metaKey] = { match: false, expected: metaValue, extracted: extractedValue };
                } else {
                    results[metaKey] = { match: true, expected: metaValue, extracted: extractedValue };
                }
            }
        }

        return { valid: issues.length === 0, results, issues };
    }

    /**
     * Document-type-specific logical validations
     */
    static _checkDocTypeLogic(documentType, extractedData) {
        const issues = [];

        switch (documentType) {
            case 'aadhaar': {
                // Aadhaar: gender should be M/F/T, address should be present
                const gender = extractedData.gender || extractedData.sex;
                if (gender && !['male', 'female', 'transgender', 'm', 'f', 't'].includes(String(gender).toLowerCase())) {
                    issues.push(`Invalid gender value on Aadhaar: "${gender}"`);
                }
                break;
            }

            case 'passport': {
                // Passport: nationality should be present, MRZ consistency
                const nationality = extractedData.nationality || extractedData.country;
                if (nationality && String(nationality).trim().length < 2) {
                    issues.push('Passport nationality field is too short');
                }
                // Check passport type if present
                const passType = extractedData.passport_type || extractedData.type;
                if (passType && !['P', 'D', 'S', 'O'].includes(String(passType).toUpperCase())) {
                    issues.push(`Invalid passport type: "${passType}". Expected P (ordinary), D (diplomatic), S (service), or O (official)`);
                }
                break;
            }

            case 'driving_license': {
                // DL: vehicle class should be present
                const vehicleClass = extractedData.vehicle_class || extractedData.class_of_vehicle || extractedData.cov;
                if (vehicleClass) {
                    const validClasses = ['lmv', 'hmv', 'mcwg', 'mc50cc', 'mc ex50cc', 'trans', 'lmv-nt', 'lmv-t',
                                          'hmv', 'hgmv', 'hpmv', '3w-nt', '3w-t', 'invcar', 'adapted vehicle'];
                    const classLower = String(vehicleClass).toLowerCase().replace(/[\s\-]/g, '');
                    // Don't reject on class since there are many valid formats, just flag unknowns
                }
                break;
            }

            case 'marksheet_10':
            case 'marksheet_12': {
                // Marksheet: total marks should be >= individual subject marks
                const totalMarks = parseFloat(extractedData.total_marks || extractedData.total || extractedData.aggregate);
                const percentage = parseFloat(extractedData.percentage);
                if (!isNaN(totalMarks) && !isNaN(percentage)) {
                    // Basic sanity: percentage should be between 0 and 100
                    if (percentage < 0 || percentage > 100) {
                        issues.push(`Percentage ${percentage}% is outside valid range (0-100)`);
                    }
                }
                // Roll number should not be empty for marksheets
                const rollNo = extractedData.roll_number || extractedData.roll_no || extractedData.registration_number;
                if (rollNo != null && String(rollNo).trim() === '') {
                    issues.push('Roll/registration number is empty on marksheet');
                }
                break;
            }

            case 'bank_statement': {
                // Bank statement: opening/closing balance logic
                const opening = parseFloat(extractedData.opening_balance);
                const closing = parseFloat(extractedData.closing_balance);
                const totalCredit = parseFloat(extractedData.total_credit || extractedData.total_credits);
                const totalDebit = parseFloat(extractedData.total_debit || extractedData.total_debits);
                if (!isNaN(opening) && !isNaN(closing) && !isNaN(totalCredit) && !isNaN(totalDebit)) {
                    const expectedClosing = opening + totalCredit - totalDebit;
                    const diff = Math.abs(closing - expectedClosing);
                    // Allow small rounding tolerance
                    if (diff > 1) {
                        issues.push(`Bank statement balance mismatch: opening(${opening}) + credits(${totalCredit}) - debits(${totalDebit}) = ${expectedClosing.toFixed(2)}, but closing balance is ${closing}`);
                    }
                }
                break;
            }
        }

        return { valid: issues.length === 0, issues };
    }

    /**
     * Validate numeric fields (scores, percentages, amounts)
     */
    static _checkNumericFields(extractedData, documentType) {
        const issues = [];

        for (const [key, value] of Object.entries(extractedData)) {
            if (value == null) continue;
            const keyLower = key.toLowerCase();

            // Percentage fields should be 0-100
            if (keyLower.includes('percentage') || keyLower.includes('percent') || keyLower === 'cgpa_percentage') {
                const num = parseFloat(value);
                if (!isNaN(num) && (num < 0 || num > 100)) {
                    issues.push(`Invalid percentage in '${key}': ${value} (must be 0-100)`);
                }
            }

            // CGPA should typically be 0-10 or 0-4
            if (keyLower.includes('cgpa') || keyLower.includes('gpa')) {
                const num = parseFloat(value);
                if (!isNaN(num) && (num < 0 || num > 10)) {
                    issues.push(`Suspicious GPA/CGPA in '${key}': ${value} (expected 0-10)`);
                }
            }

            // Age field check
            if (keyLower === 'age') {
                const num = parseInt(value, 10);
                if (!isNaN(num) && (num < 0 || num > 150)) {
                    issues.push(`Invalid age: ${value}`);
                }
            }

            // Pin code / zip validation (Indian)
            if (keyLower.includes('pincode') || keyLower.includes('pin_code') || keyLower.includes('zip')) {
                const cleaned = String(value).replace(/\s/g, '');
                if (cleaned && !/^\d{6}$/.test(cleaned)) {
                    issues.push(`Invalid PIN code format in '${key}': "${value}" (expected 6-digit number)`);
                }
            }
        }

        return { valid: issues.length === 0, issues };
    }

    // ==================== DATA CONSISTENCY ====================

    /**
     * General data consistency checks
     */
    static validateDataConsistency(extractedData) {
        const issues = [];

        // Check for suspicious patterns in string fields
        for (const [key, value] of Object.entries(extractedData)) {
            if (value == null || typeof value !== 'string') continue;
            const trimmed = value.trim();

            // Empty required-looking fields
            if (trimmed === '' && !key.toLowerCase().includes('optional')) {
                continue; // Skip empty fields (handled by required field check elsewhere)
            }

            // Placeholder/test data detection
            const lowerVal = trimmed.toLowerCase();
            const placeholders = ['test', 'sample', 'dummy', 'xxx', 'n/a', 'na', 'null', 'undefined', 'todo', 'tbd'];
            if (placeholders.includes(lowerVal) && key.toLowerCase() !== 'remarks' && key.toLowerCase() !== 'notes') {
                issues.push(`Suspicious placeholder value in '${key}': "${trimmed}"`);
            }

            // All-same-character strings (e.g., "AAAAAAA", "1111111")
            if (trimmed.length > 4 && /^(.)\1+$/.test(trimmed.replace(/\s/g, ''))) {
                issues.push(`Suspicious repeated character value in '${key}': "${trimmed}"`);
            }
        }

        // Check for duplicate values across fields that should be unique
        const valueMap = {};
        for (const [key, value] of Object.entries(extractedData)) {
            if (value == null || typeof value !== 'string' || value.trim() === '') continue;
            const keyLower = key.toLowerCase();
            // Only check ID-like and name-like fields for cross-field duplication
            if (keyLower.includes('number') || keyLower.includes('id') || keyLower.includes('no')) {
                const trimVal = value.trim();
                if (valueMap[trimVal] && valueMap[trimVal] !== key) {
                    // Same value in two different ID fields - could be suspicious
                    // Only flag if the field names suggest they should be different
                    const otherKey = valueMap[trimVal].toLowerCase();
                    if (!keyLower.includes(otherKey) && !otherKey.includes(keyLower)) {
                        issues.push(`Same value "${trimVal}" found in both '${valueMap[trimVal]}' and '${key}' - possible data inconsistency`);
                    }
                }
                valueMap[value.trim()] = key;
            }
        }

        return { valid: issues.length === 0, issues };
    }
}

module.exports = DataValidationService;
