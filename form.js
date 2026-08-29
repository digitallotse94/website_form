(function () {
  'use strict';

  // Make.com Webhook-URL hier eintragen:
  var MAKE_WEBHOOK_URL = 'https://hook.eu1.make.com/yydekbkijhm1e7688552t4z5jj0879hw';

  function init() {
    // 1. DOM references
    var form = document.getElementById('demo-request-form');
    if (!form) return;

    var submitBtn = document.getElementById('submit-btn');
    var errorBanner = document.getElementById('form-error-banner');
    var successMessage = document.getElementById('success-message');
    var existingWebsiteGroup = document.getElementById('existing-website-group');
    var primaryGoalOtherGroup = document.getElementById('primary-goal-other-group');
    var optionalSection = document.getElementById('optional-section');

    var existingWebsiteInput = document.getElementById('existing_website');
    var primaryGoalOtherInput = document.getElementById('primary_goal_other');
    var privacyCheckbox = document.getElementById('privacy_acknowledged');

    // 4. Email validation helper
    function isValidEmail(email) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    // 5. Show field error helper
    function showFieldError(fieldId) {
      var group = document.getElementById(fieldId) || document.querySelector('input[name="' + fieldId + '"]');
      if (group) {
        var container = group.closest('.field-group, fieldset');
        if (container) {
          container.classList.add('field-error');
        } else {
          group.classList.add('field-error');
        }
      }
      var errorEl = document.getElementById(fieldId + '-error');
      if (errorEl) {
        errorEl.style.display = 'block';
      }
    }

    // Clear single field error helper
    function clearFieldError(fieldId) {
      var target = document.getElementById(fieldId) || document.querySelector('input[name="' + fieldId + '"]');
      if (target) {
        var container = target.closest('.field-group, fieldset');
        if (container) {
          container.classList.remove('field-error');
        } else {
          target.classList.remove('field-error');
        }
      }
      var errorEl = document.getElementById(fieldId + '-error');
      if (errorEl) {
        errorEl.style.display = 'none';
      }
    }

    // 6. Clear all errors helper
    function clearAllErrors() {
      var errorFields = document.querySelectorAll('.field-error');
      Array.prototype.forEach.call(errorFields, function (el) {
        el.classList.remove('field-error');
      });

      var errorMessages = document.querySelectorAll('.error-msg');
      Array.prototype.forEach.call(errorMessages, function (el) {
        el.style.display = 'none';
      });

      if (errorBanner) {
        errorBanner.style.display = 'none';
        errorBanner.textContent = '';
      }
    }

    // 2. Conditional field: existing website
    var hasExistingWebsiteRadios = document.querySelectorAll('input[name="has_existing_website"]');
    Array.prototype.forEach.call(hasExistingWebsiteRadios, function (radio) {
      radio.addEventListener('change', function (e) {
        var val = e.target.value;
        if (val === 'yes') {
          if (existingWebsiteGroup) existingWebsiteGroup.style.display = 'block';
          if (existingWebsiteInput) existingWebsiteInput.required = true;
        } else if (val === 'no') {
          if (existingWebsiteGroup) existingWebsiteGroup.style.display = 'none';
          if (existingWebsiteInput) {
            existingWebsiteInput.required = false;
            existingWebsiteInput.value = '';
            clearFieldError('existing_website');
          }
        }
        clearFieldError('has_existing_website');
      });
    });

    // 3. Conditional field: primary goal other
    var primaryGoalRadios = document.querySelectorAll('input[name="primary_goal"]');
    Array.prototype.forEach.call(primaryGoalRadios, function (radio) {
      radio.addEventListener('change', function (e) {
        var val = e.target.value;
        if (val === 'sonstiges') {
          if (primaryGoalOtherGroup) primaryGoalOtherGroup.style.display = 'block';
        } else {
          if (primaryGoalOtherGroup) primaryGoalOtherGroup.style.display = 'none';
          if (primaryGoalOtherInput) primaryGoalOtherInput.value = '';
        }
      });
    });

    // 8. Clear field error on input / change
    var requiredInputIds = ['company_name', 'contact_name', 'email', 'existing_website'];
    requiredInputIds.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', function () {
          clearFieldError(id);
        });
      }
    });

    if (privacyCheckbox) {
      privacyCheckbox.addEventListener('change', function () {
        clearFieldError('privacy_acknowledged');
      });
    }

    // 7. Form submit handler
    form.addEventListener('submit', function (e) {
      e.preventDefault();

      // a) Clear all previous errors
      clearAllErrors();

      // b) Collect values
      var companyNameEl = document.getElementById('company_name');
      var contactNameEl = document.getElementById('contact_name');
      var emailEl = document.getElementById('email');
      var existingWebsiteEl = document.getElementById('existing_website');
      var privacyAcknowledgedEl = document.getElementById('privacy_acknowledged');
      var honeypotEl = document.getElementById('website_url_confirm');

      var phoneEl = document.getElementById('phone');
      var industryEl = document.getElementById('industry');
      var locationEl = document.getElementById('location');
      var primaryGoalOtherEl = document.getElementById('primary_goal_other');
      var servicesEl = document.getElementById('services');
      var differentiatorsEl = document.getElementById('differentiators');

      var checkedHasWebsite = document.querySelector('input[name="has_existing_website"]:checked');
      var checkedPrimaryGoal = document.querySelector('input[name="primary_goal"]:checked');
      var checkedCtas = document.querySelectorAll('input[name="preferred_cta"]:checked');

      var company_name = companyNameEl ? companyNameEl.value.trim() : '';
      var contact_name = contactNameEl ? contactNameEl.value.trim() : '';
      var email = emailEl ? emailEl.value.trim() : '';
      var has_existing_website = checkedHasWebsite ? checkedHasWebsite.value : '';
      var existing_website = existingWebsiteEl ? existingWebsiteEl.value.trim() : '';
      var privacy_acknowledged = privacyAcknowledgedEl ? privacyAcknowledgedEl.checked : false;
      var website_url_confirm = honeypotEl ? honeypotEl.value : '';

      var phone = phoneEl ? phoneEl.value.trim() : '';
      var industry = industryEl ? industryEl.value.trim() : '';
      var location = locationEl ? locationEl.value.trim() : '';
      var primary_goal = checkedPrimaryGoal ? checkedPrimaryGoal.value : '';
      var primary_goal_other = primaryGoalOtherEl ? primaryGoalOtherEl.value.trim() : '';
      var services = servicesEl ? servicesEl.value.trim() : '';
      var differentiators = differentiatorsEl ? differentiatorsEl.value.trim() : '';
      var preferred_cta = Array.prototype.map.call(checkedCtas, function (cb) {
        return cb.value;
      });

      // c) Client-side validation
      var errors = [];

      if (!company_name) {
        errors.push('company_name');
      }
      if (!contact_name) {
        errors.push('contact_name');
      }
      if (!email || !isValidEmail(email)) {
        errors.push('email');
      }
      if (!has_existing_website) {
        errors.push('has_existing_website');
      }
      if (has_existing_website === 'yes' && !existing_website) {
        errors.push('existing_website');
      }
      if (!privacy_acknowledged) {
        errors.push('privacy_acknowledged');
      }

      if (errors.length > 0) {
        if (errorBanner) {
          errorBanner.textContent = 'Bitte füllen Sie alle Pflichtfelder korrekt aus.';
          errorBanner.style.display = 'block';
        }
        errors.forEach(function (fieldId) {
          showFieldError(fieldId);
        });
        var firstErrorId = errors[0];
        var firstEl = document.getElementById(firstErrorId) || document.querySelector('input[name="' + firstErrorId + '"]');
        if (firstEl && typeof firstEl.focus === 'function') {
          firstEl.focus();
        }
        return;
      }

      // Check honeypot
      if (website_url_confirm && website_url_confirm.trim() !== '') {
        // Fake success for bots
        form.style.display = 'none';
        if (successMessage) {
          successMessage.style.display = 'block';
        }
        return;
      }

      // Normalize URL for existing_website if provided
      if (existing_website && !/^https?:\/\//i.test(existing_website)) {
        existing_website = 'https://' + existing_website;
      }

      // d) Disable submit button, change text
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Anfrage wird gesendet …';
      }

      // e) Build payload for Make.com
      var payload = {
        company_name: company_name,
        contact_name: contact_name,
        email: email.toLowerCase(),
        phone: phone,
        has_existing_website: has_existing_website,
        existing_website: existing_website,
        industry: industry,
        location: location,
        primary_goal: primary_goal,
        primary_goal_other: primary_goal_other,
        services: services,
        differentiators: differentiators,
        preferred_cta: preferred_cta,
        privacy_acknowledged: privacy_acknowledged,
        submitted_at: new Date().toISOString(),
        source: 'website_demo_form'
      };

      if (!MAKE_WEBHOOK_URL || MAKE_WEBHOOK_URL.indexOf('HIER_IHRE_') !== -1) {
        if (errorBanner) {
          errorBanner.textContent = 'Bitte tragen Sie erst Ihre Make.com Webhook-URL in form.js ein.';
          errorBanner.style.display = 'block';
        }
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Kostenlosen Erstentwurf anfragen';
        }
        return;
      }

      fetch(MAKE_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      })
        .then(function (response) {
          if (response.ok) {
            // f) Success
            form.style.display = 'none';
            if (successMessage) {
              successMessage.style.display = 'block';
              successMessage.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          } else {
            // f) Failure
            if (errorBanner) {
              errorBanner.textContent = 'Die Anfrage konnte leider nicht übermittelt werden. Bitte versuchen Sie es erneut.';
              errorBanner.style.display = 'block';
            }
            if (submitBtn) {
              submitBtn.disabled = false;
              submitBtn.textContent = 'Kostenlosen Erstentwurf anfragen';
            }
          }
        })
        .catch(function () {
          // g) Network error
          if (errorBanner) {
            errorBanner.textContent = 'Die Anfrage konnte leider nicht übermittelt werden. Bitte versuchen Sie es erneut.';
            errorBanner.style.display = 'block';
          }
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Kostenlosen Erstentwurf anfragen';
          }
        });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
