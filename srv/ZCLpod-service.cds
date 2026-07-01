using { com.riotinto.s4.v as db } from '../db/ZCLpod-model';

service PODService @(path: '/pod') {

    @(
        Capabilities.UpdateRestrictions: { Updatable: isEditable },
        Capabilities.DeleteRestrictions: { Deletable: false },
        Capabilities.InsertRestrictions: { Insertable: false }
    )
    @odata.draft.enabled
    entity DeliveryHeaders as projection on db.ZCLDeliveryHeaders {
        *,
        virtual isEditable   : Boolean,
        virtual podCompleted : Boolean
    }
        actions {
            action submitPOD() returns { success: Boolean; message: String; };
        };

    @(
        Capabilities.UpdateRestrictions: { Updatable: true  },
        Capabilities.DeleteRestrictions: { Deletable: false },
        Capabilities.InsertRestrictions: { Insertable: false }
    )
    entity DeliveryItems as projection on db.ZCLDeliveryItems;

    @readonly
    entity PODReasonCodes as projection on db.ZCLPODReasonCodes;

    @readonly
    entity OverallPodStatusVH as select from db.ZCLPODStatusCodes;

}

// ─── Field-level immutability ─────────────────────────────────────────────────

annotate PODService.DeliveryHeaders with {
    shipToParty @Common.Text: shipToPartyName  @Common.TextArrangement: #TextLast;
    goodsMovementStatus @Common.Text: goodsMovementStatusText  @Common.TextArrangement: #TextLast;
    overallPodStatus    @Common.Text: overallPodStatusText     @Common.TextArrangement: #TextLast
                        @Common.ValueListWithFixedValues: true
                        @Common.ValueList: {
                            CollectionPath: 'OverallPodStatusVH',
                            Parameters: [
                                {
                                    $Type:             'Common.ValueListParameterOut',
                                    LocalDataProperty:  overallPodStatus,
                                    ValueListProperty: 'code'
                                },
                                {
                                    $Type:             'Common.ValueListParameterDisplayOnly',
                                    ValueListProperty: 'description'
                                }
                            ]
                        };
};

annotate PODService.DeliveryHeaders with {
    deliveryDocument     @Core.Immutable;
    salesOrganization    @Core.Immutable;
    deliveryDate         @Core.Immutable;
    documentDate         @Core.Immutable;
    shipToParty          @Core.Immutable;
    shipToPartyName      @Core.Immutable;
    shippingPoint        @Core.Immutable;
    overallPodStatus              @Core.Immutable;
    podStatusCriticality          @Core.Immutable;
    goodsMovementStatus           @Core.Immutable;
    goodsMovementStatusCriticality @Core.Immutable;
    goodsMovementStatusText       @Core.Immutable;
    overallPodStatusText          @Core.Immutable;
    actualGoodsMvmtDate           @Core.Immutable;
    // podDate and podTime are intentionally editable
}

annotate PODService.DeliveryItems with {
    deliveryDocument       @Core.Immutable  @UI.Hidden;
    deliveryDocumentItem   @Core.Immutable;
    salesOrder             @Core.Immutable;
    material               @Core.Immutable;
    itemText               @Core.Immutable;
    actualDeliveryQuantity @Core.Immutable;
    deliveryQuantityUnit   @Core.Immutable;
    podRelevanceCode       @Core.Immutable;
    podStatus              @Core.Immutable;
    goodsMovementStatus    @Core.Immutable;
    actualGoodsMvmtDate    @Core.Immutable;
    podQuantityUnit        @Core.Immutable;
    qtyDiffnSalesUn        @Core.Computed;
    podReasonCode          @(
        Common.ValueListWithFixedValues: false,
        Common.ValueList: {
            CollectionPath: 'PODReasonCodes',
            Parameters: [
                {
                    $Type:             'Common.ValueListParameterOut',
                    LocalDataProperty:  podReasonCode,
                    ValueListProperty: 'code'
                },
                {
                    $Type:             'Common.ValueListParameterDisplayOnly',
                    ValueListProperty: 'description'
                }
            ]
        }
    );
    // podQuantity and podReasonCode are intentionally editable
}

// ─── Worklist (List Report) ──────────────────────────────────────────────────

annotate PODService.DeliveryHeaders with @(
    UI.SelectionFields: [
        deliveryDocument,
        shipToParty,
        overallPodStatus
    ],
    UI.LineItem: [
        { Value: deliveryDocument,  Label: 'Delivery Doc'   },
        { Value: deliveryDate,      Label: 'Delivery Date'  },
        { Value: shipToParty,       Label: 'Ship-to Party'  },
        { Value: shipToPartyName,   Label: 'Ship-to Name'   },
        { Value: shippingPoint,     Label: 'Shipping Point' },
        {
            Value:                     overallPodStatus,
            Label:                     'POD Status',
            Criticality:               podStatusCriticality,
            CriticalityRepresentation: #WithIcon
        }
    ]
);

// ─── Object Page ─────────────────────────────────────────────────────────────

annotate PODService.DeliveryHeaders with @(
    UI.UpdateHidden: podCompleted,
    UI.HeaderInfo: {
        TypeName:       'Delivery',
        TypeNamePlural: 'Deliveries',
        Title:          { Value: deliveryDocument },
        Description:    { Value: shipToPartyName }
    },
    UI.HeaderFacets: [
        {
            $Type:  'UI.ReferenceFacet',
            Target: '@UI.FieldGroup#Context'
        }
    ],
    UI.FieldGroup#Context: {
        Data: [
            { Value: deliveryDocument, Label: 'Outbound Deliv.' },
            { Value: shipToParty,      Label: 'Ship-to Party'   },
            { Value: documentDate,     Label: 'Document Date'   }
        ]
    },
    UI.Facets: [
        {
            $Type: 'UI.CollectionFacet',
            ID:    'OverallPOD',
            Label: 'Overall POD',
            Facets: [
                {
                    $Type:  'UI.ReferenceFacet',
                    ID:     'PODDetailsSection',
                    Label:  'Proof of Delivery',
                    Target: '@UI.FieldGroup#POD'
                },
                {
                    $Type:  'UI.ReferenceFacet',
                    ID:     'AllItemsSection',
                    Label:  'All Items',
                    Target: 'deliveryItems/@UI.LineItem'
                }
            ]
        }
    ],
    UI.FieldGroup#POD: {
        Data: [
            { Value: actualGoodsMvmtDate, Label: 'Actual GI Date'   },
            { Value: shippingPoint,       Label: 'Shipping Point'    },
            {
                Value:       goodsMovementStatus,
                Label:       'Goods Mvmt Status',
                Criticality: goodsMovementStatusCriticality
            },
            { Value: podDate, Label: 'POD Date' },
            { Value: podTime, Label: 'POD Time' },
            {
                Value:       overallPodStatus,
                Label:       'POD Status',
                Criticality: podStatusCriticality
            },
            {
                $Type:  'UI.DataFieldForAction',
                Label:  'Confirm POD',
                Action: 'PODService.submitPOD'
            },
            { Value: isEditable, Label: 'Editable', ![@UI.Hidden]: true }
        ]
    }
);

// ─── All Items table toolbar: Confirm button (no Inline → table toolbar, not row button) ──

annotate PODService.DeliveryHeaders with actions {
    submitPOD @(
        Common.IsActionCritical:  true,
        Core.OperationAvailable:  isEditable
    );
};

annotate PODService.DeliveryItems with @(
    UI.LineItem: [
        { Value: deliveryDocumentItem,   Label: 'Item',          ![@UI.Importance]: #High },
        { Value: salesOrder,             Label: 'Sales Order',   ![@UI.Importance]: #High },
        { Value: material,               Label: 'Material',      ![@UI.Importance]: #High },
        { Value: itemText,               Label: 'Description',   ![@UI.Importance]: #High },
        { Value: actualDeliveryQuantity, Label: 'Delivered Qty', ![@UI.Importance]: #High },
        { Value: deliveryQuantityUnit,   Label: 'Unit',          ![@UI.Importance]: #High },
        { Value: podQuantity,            Label: 'POD Quantity',   ![@UI.Importance]: #High },
        { Value: qtyDiffnSalesUn,        Label: 'Qty Diff',       ![@UI.Importance]: #High },
        { Value: podReasonCode,          Label: 'Reason Code',    ![@UI.Importance]: #High }
    ]
);
