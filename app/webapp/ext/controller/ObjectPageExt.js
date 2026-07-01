sap.ui.define([
    "sap/ui/core/mvc/ControllerExtension",
    "sap/m/MessageBox",
    "sap/m/MessageToast"
], function (ControllerExtension, MessageBox, MessageToast) {
    "use strict";

    return ControllerExtension.extend("zcpeldelivpod.ext.controller.ObjectPageExt", {

        onConfirmPOD: function () {
            const oView    = this.base.getView();
            const oModel   = oView.getModel();
            const oContext = oView.getBindingContext();

            if (!oContext) {
                MessageBox.error("No delivery context found.");
                return;
            }

            const sDeliveryDoc = oContext.getProperty("deliveryDocument");

            MessageBox.confirm(
                "Are you sure you want to confirm POD for delivery " + sDeliveryDoc + "?",
                {
                    title:            "Confirm POD",
                    actions:          [MessageBox.Action.OK, MessageBox.Action.CANCEL],
                    emphasizedAction: MessageBox.Action.OK,
                    onClose: function (sAction) {
                        if (sAction !== MessageBox.Action.OK) return;

                        const oActionBinding = oModel.bindContext(
                            "PODService.submitPOD(...)",
                            oContext,
                            { $$inheritExpandSelect: false }
                        );

                        oActionBinding.execute("$auto").then(function () {
                            MessageToast.show("POD submitted successfully!");
                            oModel.refresh();
                        }).catch(function (oError) {
                            const sMsg = oError?.error?.message
                                || oError?.message
                                || JSON.stringify(oError);
                            MessageBox.error("Failed to submit POD: " + sMsg);
                        });
                    }
                }
            );
        }
    });
});