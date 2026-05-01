@lint_allow("W001,W002")
permit(principal, action, resource) when { true };

@lint_allow("W001,W002")
permit(principal, action, resource) when { 1 == 1 };
